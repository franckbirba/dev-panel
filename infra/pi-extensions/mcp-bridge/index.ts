/**
 * MCP-bridge extension for Pi (`@earendil-works/pi-coding-agent`).
 *
 * Pi 0.74 deliberately ships zero built-in MCP support — the docs say so
 * explicitly. That means a pi-driven agent (ephemeral builder OR Shelly
 * running on Pi when Claude quota is exhausted) sees only Pi's built-ins
 * (read/edit/write/bash/grep/find/ls) plus whatever extensions we load.
 *
 * Without this bridge, those agents have NO access to:
 *   - plane MCP            (work items, pages, attachments)
 *   - devpanel MCP         (memory_search/write, enqueue_job, threads,
 *                           captures, dispatch, glitchtip_get_issue, …)
 *   - affine-{zeno,devpanl,edms} (workspace docs)
 *   - playwright           (browser control)
 *   - telegram             (only useful for Shelly, stripped from worker config)
 *   - any future MCP we add
 *
 * What this extension does on boot:
 *   1. Read the MCP config file at PI_MCP_CONFIG (default
 *      `~/.mcp-worker.json` for the worker, set to `~/.mcp.json` for
 *      Shelly). Same JSON shape Claude Code uses: `{ mcpServers: { name:
 *      { command, args, env } } }`.
 *   2. For each entry, spawn the server as a stdio child via
 *      `@modelcontextprotocol/sdk` `StdioClientTransport`, list its tools.
 *   3. Re-register each tool with Pi as `mcp__<server>__<tool>` (the same
 *      naming Claude Code uses, so SOUL prompts and memory writes that
 *      reference tool names stay valid across both harnesses).
 *   4. Each registered tool's `execute` proxies to `client.callTool({
 *      name, arguments })` and translates the MCP CallToolResult into
 *      Pi's `AgentToolResult` shape.
 *   5. On `session_shutdown` (and best-effort on `process.exit`), close
 *      every MCP client gracefully so child processes don't linger.
 *
 * Why `Type.Unsafe(inputSchema)`:
 *   Pi's `defineTool` types `parameters` as TypeBox `TSchema`, but
 *   internally pi-ai (e.g. providers/openai-completions.js) just passes
 *   `tool.parameters` straight through to the provider as JSON Schema
 *   (the comment in pi-ai literally says "TypeBox already generates
 *   JSON Schema"). And there is zero `Value.Check` / TypeCompiler call
 *   in pi's runtime. So an MCP tool's `inputSchema` (which IS already a
 *   JSON Schema) is structurally a valid TSchema for pi's purposes;
 *   `Type.Unsafe` is just the typed escape hatch.
 *
 * Loaded via:
 *   pi --extension /home/deploy/projects/dev-panel/infra/pi-extensions/mcp-bridge
 *
 * Tunables (env vars):
 *   PI_MCP_CONFIG          — path to the mcp.json (default ~/.mcp-worker.json)
 *   PI_MCP_BRIDGE_TIMEOUT  — per-call timeout in ms (default 120000)
 *   PI_MCP_BRIDGE_DEBUG    — if "1", log bridge lifecycle to stderr
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

interface McpFile {
	mcpServers?: Record<string, McpServerConfig>;
}

interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.PI_MCP_BRIDGE_TIMEOUT || "120000");
const DEBUG = process.env.PI_MCP_BRIDGE_DEBUG === "1";

function debug(...args: unknown[]) {
	if (DEBUG) console.error("[mcp-bridge]", ...args);
}

function resolveConfigPath(): string {
	if (process.env.PI_MCP_CONFIG) return process.env.PI_MCP_CONFIG;
	return join(homedir(), ".mcp-worker.json");
}

function loadMcpConfig(path: string): Record<string, McpServerConfig> {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ENOENT") {
			console.error(
				`[mcp-bridge] config not found at ${path} — no MCP servers loaded. ` +
					`Set PI_MCP_CONFIG or create ~/.mcp-worker.json.`,
			);
			return {};
		}
		throw err;
	}
	let parsed: McpFile;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		console.error(`[mcp-bridge] config at ${path} is not valid JSON: ${(err as Error).message}`);
		return {};
	}
	return parsed.mcpServers ?? {};
}

/**
 * Connect a single stdio MCP server. Returns the client + the discovered
 * tool list. We deliberately fail soft per-server: if `plane-mcp` is broken
 * we still want the agent to have `devpanel-mcp` etc. — losing one server
 * shouldn't take down the whole bridge.
 */
async function connectServer(
	name: string,
	cfg: McpServerConfig,
): Promise<{ client: Client; tools: McpToolInfo[] } | null> {
	debug(`connecting ${name}: ${cfg.command} ${(cfg.args ?? []).join(" ")}`);

	// Inherit our PATH so commands like `node`, `npx`, `bun`, `uvx` resolve
	// the same way they do for Claude. The MCP SDK's getDefaultEnvironment
	// strips most of process.env for safety; we override with the merged set.
	const childEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === "string") childEnv[k] = v;
	}
	for (const [k, v] of Object.entries(cfg.env ?? {})) {
		childEnv[k] = v;
	}

	const transport = new StdioClientTransport({
		command: cfg.command,
		args: cfg.args ?? [],
		env: childEnv,
		stderr: "pipe",
	});

	const client = new Client(
		{ name: "pi-mcp-bridge", version: "0.1.0" },
		{ capabilities: {} },
	);

	try {
		await client.connect(transport);
	} catch (err) {
		console.error(
			`[mcp-bridge] failed to connect ${name}: ${(err as Error).message}`,
		);
		try {
			await transport.close();
		} catch {
			/* ignore */
		}
		return null;
	}

	let toolsResp: { tools?: McpToolInfo[] };
	try {
		toolsResp = (await client.listTools()) as { tools?: McpToolInfo[] };
	} catch (err) {
		console.error(
			`[mcp-bridge] ${name}: listTools failed: ${(err as Error).message}`,
		);
		try {
			await client.close();
		} catch {
			/* ignore */
		}
		return null;
	}

	const tools = toolsResp.tools ?? [];
	debug(`${name}: ${tools.length} tools`);
	return { client, tools };
}

/** Convert an MCP CallToolResult to Pi's AgentToolResult shape. */
function toPiResult(mcpResult: {
	content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
	isError?: boolean;
	structuredContent?: unknown;
}): {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	details: unknown;
	isError?: boolean;
} {
	const blocks: Array<
		{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
	> = [];
	for (const c of mcpResult.content ?? []) {
		if (c.type === "text" && typeof c.text === "string") {
			blocks.push({ type: "text", text: c.text });
		} else if (c.type === "image" && typeof c.data === "string") {
			blocks.push({
				type: "image",
				data: c.data,
				mimeType: c.mimeType || "image/png",
			});
		} else if (c.type === "resource" || c.type === "resource_link") {
			// Flatten resource references to text — pi has no resource concept.
			blocks.push({ type: "text", text: JSON.stringify(c) });
		}
	}
	if (blocks.length === 0) {
		// Some MCP tools return only `structuredContent` with no `content`.
		// Surface it as text so the model has something to read.
		blocks.push({
			type: "text",
			text: JSON.stringify(mcpResult.structuredContent ?? {}, null, 2),
		});
	}
	return {
		content: blocks,
		details: mcpResult.structuredContent ?? null,
		isError: mcpResult.isError === true ? true : undefined,
	};
}

/**
 * Per-server guidelines attached to ONE tool per server (the first registered).
 * Pi de-duplicates guideline strings, so attaching them once is enough — but
 * we don't know which tool will be first until enumeration time. This map is
 * consulted in `attachServerGuidelines` below; if the server has guidelines,
 * they're spliced onto the first tool registered for that server.
 *
 * Why this matters: Qwen3 sees `mcp__plane-mcp__list_projects` as an opaque
 * function name. Without these guidelines, it doesn't know "plane = Plane the
 * work-item tracker", "use plane_dispatch_work_item to start a job", etc.
 * Tool descriptions explain individual tools; these guidelines give Qwen3 the
 * orchestration story across them.
 */
const SERVER_GUIDELINES: Record<string, string[]> = {
	"plane-mcp": [
		"Plane is the work-item tracker (`plane.devpanl.dev` workspace `devpanl`). Use `mcp__plane-mcp__*` tools when the user asks about work items, sprints, cycles, projects. Sequence IDs are short like `DEVPA-93` / `ZENO-42` / `EDMS-17`; UUIDs are accepted everywhere a sequence works.",
	],
	"devpanel-mcp": [
		"DevPanel MCP carries every studio-internal capability: `memory_search` / `memory_write` (pgvector long-term memory shared across sessions), `enqueue_job` / `cancel_job` (BullMQ dispatch to ephemeral coding agents), `plane_dispatch_work_item` (the canonical way to start a job from a Plane sequence ID), `list_captures` / `route_capture` (triage inbox), `transcript_replay_recent` (rebuild context after restart), `glitchtip_get_issue` / `glitchtip_resolve_issue`, `thread_append`, etc.",
		"Before a non-trivial decision (dispatching a job, dropping a capture, answering 'what did we decide on X'), call `mcp__devpanel-mcp__memory_search` with a query that summarizes intent. After a decision worth surviving the session (triage, dispatch override, retro), call `mcp__devpanel-mcp__memory_write` with kind=decision/handoff/retrospective.",
	],
	"affine-zeno": [
		"AFFiNE workspace for the Zeno product. Use for long-form docs (specs, retros, runbooks). For quick work-item-attached notes prefer Plane Pages instead.",
	],
	"affine-devpanl": [
		"AFFiNE workspace for the DevPanel studio (internal docs, architecture, ops runbooks). Same long-form-docs rule as the other AFFiNE workspaces.",
	],
	"affine-edms": [
		"AFFiNE workspace for EDMS. Same long-form-docs rule as the other AFFiNE workspaces.",
	],
	"github-mcp": [
		"GitHub MCP for issue/repo metadata reads. For PR creation/review prefer the dedicated `gh_pr_create` / `gh_pr_view` / `gh_pr_comment` tools (from the github extension) — they avoid shell quoting failures on titles with apostrophes.",
	],
	"playwright": [
		"Playwright MCP for browser automation. Use only when the user asks for a UI check that can't be answered any other way; cold-start is ~5s and each page eats memory.",
	],
};

/**
 * Per-tool snippet derived from the upstream MCP description. Truncates to
 * one line so pi's "Available tools:" section stays scannable; falls back to
 * a generic placeholder if the upstream tool has no description.
 */
function deriveSnippet(serverName: string, tool: McpToolInfo): string {
	const desc = (tool.description || "").trim();
	if (!desc) return `Proxy to ${serverName}.${tool.name} (no upstream description).`;
	// Take the first sentence or 140 chars, whichever is shorter.
	const firstLine = desc.split(/[\n.]/)[0].trim();
	const trimmed = firstLine.length > 140 ? firstLine.slice(0, 137) + "..." : firstLine;
	return trimmed || `Proxy to ${serverName}.${tool.name}.`;
}

/**
 * Build a Pi tool that proxies to a single MCP tool on a single client.
 * The MCP tool's `inputSchema` is JSON Schema; we wrap with Type.Unsafe so
 * it satisfies pi's TSchema constraint without TypeBox actually validating
 * it (pi doesn't validate at runtime — see header comment).
 *
 * `firstForServer` flag controls whether the per-server guidelines are
 * attached. We attach them to the FIRST tool of each server (alphabetical
 * order on the upstream listTools result) so they appear once in pi's
 * Guidelines section even if the model only enables some tools.
 */
function buildPiTool(
	serverName: string,
	tool: McpToolInfo,
	client: Client,
	firstForServer: boolean,
) {
	const piName = `mcp__${serverName}__${tool.name}`;
	const schema = (tool.inputSchema as Record<string, unknown> | undefined) || {
		type: "object",
		properties: {},
	};
	const guidelines = firstForServer ? SERVER_GUIDELINES[serverName] : undefined;
	return defineTool({
		name: piName,
		label: `${serverName}.${tool.name}`,
		promptSnippet: deriveSnippet(serverName, tool),
		...(guidelines && guidelines.length > 0 ? { promptGuidelines: guidelines } : {}),
		description:
			tool.description ||
			`Proxy to MCP server "${serverName}" tool "${tool.name}". See the server's docs for argument shape.`,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		parameters: Type.Unsafe<any>(schema as any),
		async execute(_id, params, signal) {
			let result;
			try {
				result = (await client.callTool(
					{ name: tool.name, arguments: (params ?? {}) as Record<string, unknown> },
					undefined,
					{
						timeout: DEFAULT_TIMEOUT_MS,
						signal,
					},
				)) as Parameters<typeof toPiResult>[0];
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									ok: false,
									tool: piName,
									error: (err as Error).message,
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
			return toPiResult(result);
		},
	});
}

export default async function (pi: ExtensionAPI) {
	const configPath = resolveConfigPath();
	const servers = loadMcpConfig(configPath);
	const serverNames = Object.keys(servers);
	if (serverNames.length === 0) {
		debug(`no servers in ${configPath}, bridge is idle`);
		return;
	}
	debug(`loading ${serverNames.length} servers from ${configPath}`);

	// Connect every server in parallel — startup latency dominates here
	// (each child has to boot node/npx/uvx/bun + run its own MCP handshake).
	const settled = await Promise.all(
		serverNames.map(async (name) => {
			const cfg = servers[name];
			try {
				const got = await connectServer(name, cfg);
				return { name, got };
			} catch (err) {
				console.error(
					`[mcp-bridge] ${name}: unexpected error: ${(err as Error).message}`,
				);
				return { name, got: null };
			}
		}),
	);

	const clients: Client[] = [];
	let totalTools = 0;
	for (const { name, got } of settled) {
		if (!got) continue;
		clients.push(got.client);
		// Track whether we've already attached the per-server guidelines so
		// they only land once even though Pi de-duplicates them anyway.
		let firstForServer = true;
		for (const tool of got.tools) {
			pi.registerTool(buildPiTool(name, tool, got.client, firstForServer));
			firstForServer = false;
			totalTools++;
		}
	}
	debug(`registered ${totalTools} tools across ${clients.length} servers`);

	// Cleanup. Two paths because we can't trust either alone:
	//   - session_shutdown is the graceful pi exit path (Ctrl-C in interactive,
	//     normal completion in -p mode). Pi waits for awaited handlers.
	//   - process.on('exit') is the last-resort sync hook for hard kills.
	//     close() is async; we kick it off but can't await — best effort.
	let cleanupRan = false;
	const cleanup = async () => {
		if (cleanupRan) return;
		cleanupRan = true;
		debug(`closing ${clients.length} MCP clients`);
		await Promise.all(
			clients.map((c) =>
				c
					.close()
					.catch((err) =>
						console.error(`[mcp-bridge] close error: ${(err as Error).message}`),
					),
			),
		);
	};
	pi.on("session_shutdown", async () => {
		await cleanup();
	});
	process.on("exit", () => {
		void cleanup();
	});
	for (const sig of ["SIGINT", "SIGTERM"] as const) {
		process.once(sig, () => {
			void cleanup().finally(() => process.exit(0));
		});
	}
}
