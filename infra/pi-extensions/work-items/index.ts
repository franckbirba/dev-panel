/**
 * work-items — composite Pi tools for Plane work-item workflows.
 *
 * Why this exists: Qwen3-Coder fumbles multi-step plans that Claude
 * holds in its head. Asking Pi-Shelly "what's on Zeno?" took ~10 round-
 * trips through raw mcp__plane-mcp__* primitives (list_projects →
 * list_cycles → list_states → list_cycle_work_items → list_work_items,
 * each as a separate tool call with full context reconstruction).
 *
 * This extension wraps the chatty Plane-MCP primitives behind one
 * intent-shaped verb that does the whole stitch internally and returns
 * a flat, ready-to-display list. Same trick as github/gh_pr_create
 * (avoids shell quoting); composite tool > N primitives when the model
 * is small.
 *
 * Tools registered:
 *   work_items_list({ project, filter?, label?, limit? })
 *
 * Replaces (mechanical de-dup at mcp-bridge registration time):
 *   - mcp__plane-mcp__list_projects         (used internally for resolution)
 *   - mcp__plane-mcp__list_cycles           (used internally for current_cycle)
 *   - mcp__plane-mcp__list_cycle_work_items (used internally)
 *   - mcp__plane-mcp__list_work_items       (used internally)
 *   - mcp__plane-mcp__list_states           (used internally for state_group)
 *
 * Per franck-architect 2026-05-10: composites declare what they replace
 * via the `__pi_composite_replaces` export. mcp-bridge reads this
 * manifest at boot and skips registering the listed raw tools, so Qwen3
 * doesn't see two surfaces for the same capability (would be a
 * confusion vector). Escape hatch (using raw tools when a composite
 * has a missing field) is YAGNI: if a composite needs more, fix the
 * composite.
 *
 * Loaded via:
 *   pi --extension /home/deploy/projects/dev-panel/infra/pi-extensions/work-items
 *
 * Tunables (env vars):
 *   PLANE_API_KEY, PLANE_BASE_URL, PLANE_WORKSPACE_SLUG (same as the
 *   plane-mcp server reads — we spawn it ourselves so it inherits).
 */
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Manifest (read by mcp-bridge for de-dup) -------------------------------

/**
 * Tools this extension's composites internally compose. mcp-bridge skips
 * registering these as raw `mcp__<server>__<tool>` proxies so the model
 * doesn't see two surfaces for the same capability.
 */
export const __pi_composite_replaces = [
	"mcp__plane-mcp__list_projects",
	"mcp__plane-mcp__list_cycles",
	"mcp__plane-mcp__list_cycle_work_items",
	"mcp__plane-mcp__list_work_items",
	"mcp__plane-mcp__list_states",
] as const;

// --- Lazy upstream client ---------------------------------------------------

const PLANE_BASE_URL = process.env.PLANE_BASE_URL || "https://plane.devpanl.dev";
const PLANE_WORKSPACE_SLUG = process.env.PLANE_WORKSPACE_SLUG || "devpanl";
const PLANE_API_KEY = process.env.PLANE_API_KEY || "";

let cached: {
	client: Client;
	close: () => Promise<void>;
} | null = null;

/**
 * Spawn plane-mcp once per pi run, lazily. Reusing a single connection
 * across all composite-tool calls inside the same pi run keeps the
 * 5-call stitch under one MCP handshake. We don't pool across runs —
 * each pi process is one inbound message.
 */
async function planeClient(): Promise<Client> {
	if (cached) return cached.client;
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === "string") env[k] = v;
	}
	env.PLANE_API_KEY = PLANE_API_KEY;
	env.PLANE_BASE_URL = PLANE_BASE_URL;
	env.PLANE_WORKSPACE_SLUG = PLANE_WORKSPACE_SLUG;
	const transport = new StdioClientTransport({
		command: "/home/deploy/.local/bin/uvx",
		args: ["--python", "3.12", "plane-mcp-server", "stdio"],
		env,
		stderr: "pipe",
	});
	const client = new Client(
		{ name: "pi-work-items", version: "0.1.0" },
		{ capabilities: {} },
	);
	await client.connect(transport);
	cached = {
		client,
		close: async () => {
			try {
				await client.close();
			} catch {
				/* ignore */
			}
		},
	};
	return client;
}

// --- Caches (per pi run) ----------------------------------------------------

const projectByPrefix = new Map<string, { id: string; identifier: string; name: string }>();
const statesByProject = new Map<string, Map<string, { id: string; group: string; name: string }>>();

interface RawProject {
	id: string;
	identifier: string;
	name: string;
}
interface RawState {
	id: string;
	group: string;
	name: string;
	project: string;
}
interface RawCycle {
	id: string;
	name: string;
	is_current?: boolean;
	start_date?: string | null;
	end_date?: string | null;
}
interface RawWorkItem {
	id: string;
	name: string;
	sequence_id?: number | string;
	state?: string;
	state_id?: string;
	assignees?: string[];
	priority?: string;
	updated_at?: string;
	created_at?: string;
}

async function callJson<T>(client: Client, tool: string, args: Record<string, unknown> = {}): Promise<T> {
	const r = await client.callTool({ name: tool, arguments: args });
	const content = (r as { content?: Array<{ type?: string; text?: string }> }).content || [];
	const textBlock = content.find((c) => c?.type === "text" && typeof c.text === "string");
	if (!textBlock?.text) {
		// Some MCP tools return only structuredContent.
		const sc = (r as { structuredContent?: unknown }).structuredContent;
		if (sc !== undefined) return sc as T;
		throw new Error(`tool ${tool} returned no text/structured content`);
	}
	try {
		return JSON.parse(textBlock.text) as T;
	} catch {
		// Plane MCP sometimes returns raw text — caller decides.
		return textBlock.text as unknown as T;
	}
}

/** Resolve "ZENO", "ZENO-42", or a UUID to a project record. */
async function resolveProject(client: Client, project: string): Promise<RawProject> {
	// Strip sequence suffix if present (ZENO-42 → ZENO).
	const prefix = project.includes("-") ? project.split("-")[0].toUpperCase() : project.toUpperCase();
	if (projectByPrefix.has(prefix)) return projectByPrefix.get(prefix)!;
	// UUIDs are length-36 with dashes in known slots.
	const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(project);
	const all = await callJson<{ results?: RawProject[] } | RawProject[]>(client, "list_projects");
	const list = Array.isArray(all) ? all : all.results || [];
	for (const p of list) {
		// Cache everything once we paid for the listProjects call.
		projectByPrefix.set(p.identifier.toUpperCase(), p);
	}
	if (isUuid) {
		const found = list.find((p) => p.id === project);
		if (!found) throw new Error(`no project with id=${project}`);
		return found;
	}
	const found = projectByPrefix.get(prefix);
	if (!found) throw new Error(`no project with identifier '${prefix}' (tried prefix from '${project}')`);
	return found;
}

async function statesFor(client: Client, projectId: string): Promise<Map<string, { id: string; group: string; name: string }>> {
	if (statesByProject.has(projectId)) return statesByProject.get(projectId)!;
	const states = await callJson<{ results?: RawState[] } | RawState[]>(client, "list_states", {
		project_id: projectId,
	});
	const list = Array.isArray(states) ? states : states.results || [];
	const map = new Map<string, { id: string; group: string; name: string }>();
	for (const s of list) map.set(s.id, { id: s.id, group: s.group, name: s.name });
	statesByProject.set(projectId, map);
	return map;
}

function buildWebUrl(project: RawProject, workItemId: string): string {
	// Plane web URL format: https://plane.devpanl.dev/<slug>/projects/<project_id>/work-items/<work_item_id>
	return `${PLANE_BASE_URL}/${PLANE_WORKSPACE_SLUG}/projects/${project.id}/work-items/${workItemId}`;
}

function flatten(item: RawWorkItem, project: RawProject, stateMap: Map<string, { id: string; group: string; name: string }>) {
	const stateInfo = item.state_id ? stateMap.get(item.state_id) : undefined;
	return {
		sequence_id: item.sequence_id != null ? `${project.identifier}-${item.sequence_id}` : null,
		title: item.name,
		state: stateInfo?.name || item.state || null,
		state_group: stateInfo?.group || null,
		priority: item.priority || null,
		assignee_ids: item.assignees || [],
		updated_at: item.updated_at || null,
		url: buildWebUrl(project, item.id),
		// Keep id for the rare case the model needs to chain into a non-composite call.
		id: item.id,
	};
}

// --- The composite ----------------------------------------------------------

const FILTER_TO_GROUPS: Record<string, string[]> = {
	active: ["unstarted", "started"],
	backlog: ["backlog"],
	current_cycle: [], // handled separately via list_cycle_work_items
	all: [],
};

const workItemsList = defineTool({
	name: "work_items_list",
	label: "List work items",
	promptSnippet:
		"List work items in a project — one call instead of stitching list_projects + list_cycles + list_states + list_work_items.",
	promptGuidelines: [
		"To answer 'what's on <project>?' or 'list the active work items on Zeno/EDMS/DEVPA' use this tool, NOT the raw mcp__plane-mcp__list_* tools. It does the project resolution, state-group filtering, and (for current_cycle) cycle picking in one call. Returns a flat list with sequence_id (DEVPA-93 / ZENO-42 / EDMS-17), title, state, assignees, url — ready to summarize.",
		"`project` accepts the short identifier (ZENO, EDMS, DEVPA) or a sequence id like ZENO-42 (the suffix is ignored) or a UUID. Default `filter` is 'active' (states in groups unstarted+started); 'current_cycle' picks the cycle marked current; 'backlog' = group=backlog; 'all' = no state filter.",
	],
	description:
		"Composite: lists work items in a Plane project with one tool call. Internally resolves project name → id, fetches states for state-group filtering (or fetches the current cycle for filter='current_cycle'), then queries work items. Returns flat ready-to-display rows. Use this instead of stitching raw mcp__plane-mcp__list_* primitives.",
	parameters: Type.Object({
		project: Type.String({
			description:
				"Project identifier (e.g. 'ZENO', 'DEVPA', 'EDMS') OR a sequence id like 'ZENO-42' (suffix ignored) OR a project UUID.",
		}),
		filter: Type.Optional(
			Type.Union(
				[
					Type.Literal("active"),
					Type.Literal("backlog"),
					Type.Literal("current_cycle"),
					Type.Literal("all"),
				],
				{
					description:
						"State-group filter. 'active' = unstarted+started states (default). 'backlog' = backlog group. 'current_cycle' = items on the project's current cycle (any state). 'all' = no filter.",
				},
			),
		),
		label: Type.Optional(
			Type.String({ description: "Optional label name to filter by (e.g. 'agent-ready')." }),
		),
		limit: Type.Optional(
			Type.Integer({
				description: "Max items returned (default 50). Use 100+ only when you really need them.",
			}),
		),
	}),
	async execute(_id, params) {
		const filter = params.filter ?? "active";
		const limit = params.limit ?? 50;
		try {
			const client = await planeClient();
			const project = await resolveProject(client, params.project);

			let items: RawWorkItem[] = [];

			if (filter === "current_cycle") {
				// One call to find current cycle.
				const cycles = await callJson<{ results?: RawCycle[] } | RawCycle[]>(
					client,
					"list_cycles",
					{ project_id: project.id },
				);
				const cycleList = Array.isArray(cycles) ? cycles : cycles.results || [];
				const current = cycleList.find((c) => c.is_current);
				if (!current) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										ok: true,
										project: project.identifier,
										filter,
										message: "no current cycle on this project",
										items: [],
									},
									null,
									2,
								),
							},
						],
						details: { ok: true, items: [] },
					};
				}
				const cycleItems = await callJson<{ results?: RawWorkItem[] } | RawWorkItem[]>(
					client,
					"list_cycle_work_items",
					{ project_id: project.id, cycle_id: current.id },
				);
				items = Array.isArray(cycleItems) ? cycleItems : cycleItems.results || [];
			} else {
				const stateMap = await statesFor(client, project.id);
				const wantedGroups = new Set(FILTER_TO_GROUPS[filter] || []);
				const allowedStateIds = wantedGroups.size === 0
					? null
					: new Set(
							Array.from(stateMap.values())
								.filter((s) => wantedGroups.has(s.group))
								.map((s) => s.id),
						);
				const raw = await callJson<{ results?: RawWorkItem[] } | RawWorkItem[]>(
					client,
					"list_work_items",
					{ project_id: project.id },
				);
				const list = Array.isArray(raw) ? raw : raw.results || [];
				items = allowedStateIds
					? list.filter((it) => it.state_id && allowedStateIds.has(it.state_id))
					: list;
			}

			// Optional label filter — Plane returns labels as id arrays on the
			// work item; the MCP server's list_work_items doesn't always
			// expand them. For now we punt: if `label` is provided we leave a
			// note in the output. Worth implementing only when used in real life.
			if (params.label) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									ok: false,
									error:
										"label filter not yet implemented in this composite — call mcp__plane-mcp__list_work_items + mcp__plane-mcp__list_labels manually for now",
									hint:
										"if this happens often, expand work_items_list to resolve label names → ids upstream",
								},
								null,
								2,
							),
						},
					],
					details: null,
					isError: true,
				};
			}

			// Flatten + truncate.
			const stateMap = await statesFor(client, project.id);
			const flat = items.slice(0, limit).map((it) => flatten(it, project, stateMap));

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								ok: true,
								project: project.identifier,
								project_name: project.name,
								filter,
								count: flat.length,
								truncated: items.length > limit,
								items: flat,
							},
							null,
							2,
						),
					},
				],
				details: { ok: true, count: flat.length, items: flat },
			};
		} catch (err) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{ ok: false, error: (err as Error).message },
							null,
							2,
						),
					},
				],
				details: null,
				isError: true,
			};
		}
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(workItemsList);
	// Cleanup the lazy plane-mcp client on pi shutdown / process exit.
	pi.on("session_shutdown", async () => {
		if (cached) {
			await cached.close();
			cached = null;
		}
	});
	process.on("exit", () => {
		if (cached) void cached.close();
	});
}
