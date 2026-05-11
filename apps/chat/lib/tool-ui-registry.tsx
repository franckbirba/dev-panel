"use client";

import { makeAssistantToolUI, useThreadRuntime } from "@assistant-ui/react";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import {
	AttachmentListCard,
	CancelJobCard,
	type CancelJobResult,
	CaptureCard,
	ConsoleStreamCard,
	type Constellation,
	ErrorHaltCard,
	FleetRowCard,
	type GlitchTipIssue,
	GlitchTipIssueCard,
	GlitchTipResolutionCard,
	type GlitchTipResolutionResult,
	InlineActionsCard,
	JobStatusCard,
	type MemoryRow,
	MemorySearchCard,
	MemoryWriteCard,
	type MemoryWriteResult,
	PageContentCard,
	PageListCard,
	PageMutationCard,
	type PageMutationResult,
	type PlaneAttachment,
	type PlanePage,
	type PlanePageContent,
	QueueCard,
	ReactCanvasCard,
	RuntimeConsoleCard,
	SprintProgressCard,
	SubjectConstellationCard,
	TerminalSessionCard,
	TranscriptCard,
	type TranscriptRow,
	WorkflowDispatchCard,
	type WorkflowDispatchResult,
	type WorkflowInstance,
	WorkflowInstancesCard,
	WorkItemCard,
} from "@/components/devpanl";
import {
	type RendererPayload,
	type RendererRegistry,
	extractRendererPayload as sharedExtractRendererPayload,
} from "@/lib/chat-renderer-types";

// ─── Action wiring — turn card button clicks into chat turns ────────────────
//
// Each capability card accepts an `onAction` callback. The wrapper here
// translates the action into a fresh user message in the same thread, so
// Shelly picks it up via the next `streamText` round and either:
//   - calls another capability (Promote → promote_capture; Talk about it →
//     work_item_detail / capture follow-up; Defer → patch capture status), or
//   - asks Franck a clarifying question, or
//   - just drafts the next move in prose.
//
// This is the cheapest way to make cards interactive without rewiring chat
// state — every action becomes a user turn the LLM sees.

function useCaptureActionHandler() {
	const runtime = useThreadRuntime();
	return (action: "approve" | "defer" | "promote" | "talk", id: string) => {
		const prompts: Record<typeof action, string> = {
			// Explicit tool nudges so the LLM doesn't fish through the wrong
			// capability — capture_detail is the by-id read; promote_capture is
			// the stitched create+patch verb.
			talk: `Use capture_detail with capture_id="${id}" to load the full capture, then suggest the next move in one short sentence (don't restate the card content).`,
			promote: `Use capture_detail with capture_id="${id}" first to read the full content. Then draft a Plane work-item title/description/priority and ask me before calling promote_capture.`,
			approve: `Approve capture ${id} as-is — confirm the action briefly without restating the capture content.`,
			defer: `Defer capture ${id}. One-line reason if obvious; otherwise ask me.`,
		};
		runtime.append({
			role: "user",
			content: [{ type: "text", text: prompts[action] }],
		});
	};
}

// Per-row action chips on the FleetStatusUI cards. Each chip becomes a
// user turn that nudges the LLM to call the right MCP capability — same
// pattern as useCaptureActionHandler. Keeps the chat surface stateless
// (no direct fetch from the card; every action goes through Shelly so
// she can decide whether to confirm, apply policy, or push back).
function useFleetActionHandler() {
	const runtime = useThreadRuntime();
	return (action: string, jobId: string) => {
		const a = action.toLowerCase();
		const prompts: Record<string, string> = {
			kill: `Cancel job ${jobId} via cancel_job. Confirm briefly with the prev_state and action that came back — don't restate what the job was.`,
			tail: `Show me the last 50 lines of job ${jobId} via tail_log_snapshot.`,
			pause: `Pause job ${jobId} if the worker supports it; otherwise tell me it's not supported and propose Kill.`,
			approve: `Approve the awaiting-approval gate on job ${jobId} and continue the workflow.`,
			reply: `Open the job ${jobId} thread so I can reply to its blocker — show me the last few messages from that thread (thread_messages_recent with subject job/${jobId}).`,
			retry: `Retry job ${jobId} — re-enqueue with the same payload via the appropriate dispatch capability.`,
		};
		const text =
			prompts[a] ??
			`Take action "${action}" on job ${jobId} via the right MCP tool. Confirm briefly.`;
		runtime.append({
			role: "user",
			content: [{ type: "text", text }],
		});
	};
}

// ─── Registry — one entry per capability ────────────────────────────────────
//
// Capabilities are defined in `src/capabilities/` and surface to the LLM via
// `src/mcp/server.js#registerCapabilities`. Each capability declares a
// `renderHint` (string) which we use here to bind the right React card.
//
// The chat sees the tool name (matches the capability `name`); the
// `makeAssistantToolUI({ toolName, render })` hook below picks each tool's
// JSON result out of the stream and feeds it to the right component.
//
// Rules:
//   - One file per capability up the stack — the renderer here only knows
//     how to unpack the JSON the handler returned.
//   - Tool results are stringified JSON inside `result.content[0].text`. We
//     parse defensively and fall back to ToolFallback on shape drift.
//   - For tools the chat *can* call but doesn't need a custom UI for
//     (memory_write, enqueue_job, raw plumbing), we don't register here —
//     the assistant-ui ToolFallback handles them as collapsible JSON.

// Tool results arrive in two shapes:
//   - MCP wire format: { content: [{ type: 'text', text: '<json>' }], isError? }
//     (every capability today, served via experimental_createMCPClient).
//   - AI SDK structured shape: the object the tool's `execute` returned
//     directly (no `content` array). Invisible today since all tools go
//     through MCP, but keep the path so a future server-side AI SDK tool
//     ({ tool({...}) }) renders instead of falling through to ToolFallback.
//     (DEVPA-214)
function parseToolText(result: unknown): unknown | null {
	if (!result || typeof result !== "object") return null;
	const r = result as { content?: unknown; isError?: boolean };
	// No MCP envelope keys → treat as AI SDK structured result.
	if (!("content" in r) && !("isError" in r)) return r;
	if (r.isError) return null;
	const content = r.content as
		| Array<{ type: string; text?: string }>
		| undefined;
	const text = content?.[0]?.text;
	if (typeof text !== "string") return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// ─── Capability renderers ────────────────────────────────────────────────────

function TriageInboxView({
	data,
}: {
	data: {
		total_new?: number;
		by_project?: Record<string, number>;
		captures?: Array<Parameters<typeof CaptureCard>[0]["capture"]>;
	};
}) {
	const onAction = useCaptureActionHandler();
	return (
		<div className="my-2 flex w-full flex-col gap-2">
			<div className="flex items-center gap-3 text-[11.5px] text-[var(--color-foreground-muted)]">
				<span className="font-mono">{data.total_new ?? 0} pending</span>
				{data.by_project &&
					Object.entries(data.by_project).map(([k, v]) => (
						<span key={k} className="font-mono">
							{k}: {v}
						</span>
					))}
			</div>
			{(data.captures ?? []).map((c) => (
				<CaptureCard key={c.id} capture={c} onAction={onAction} />
			))}
		</div>
	);
}

const TriageInboxUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "triage_inbox",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as {
			total_new?: number;
			by_project?: Record<string, number>;
			captures?: Array<Parameters<typeof CaptureCard>[0]["capture"]>;
		} | null;
		if (!data || status.type === "running")
			return (
				<ToolFallback
					toolName="triage_inbox"
					args={args}
					result={result}
					status={status}
				/>
			);
		return <TriageInboxView data={data} />;
	},
});

function CaptureListView({
	captures,
}: {
	captures: Array<Parameters<typeof CaptureCard>[0]["capture"]>;
}) {
	const onAction = useCaptureActionHandler();
	return (
		<div className="my-2 flex w-full flex-col gap-2">
			{captures.map((c) => (
				<CaptureCard key={c.id} capture={c} onAction={onAction} />
			))}
		</div>
	);
}

const CaptureListUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "capture_list",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as {
			captures?: Array<Parameters<typeof CaptureCard>[0]["capture"]>;
		} | null;
		if (!data || status.type === "running")
			return (
				<ToolFallback
					toolName="capture_list"
					args={args}
					result={result}
					status={status}
				/>
			);
		return <CaptureListView captures={data.captures ?? []} />;
	},
});

function CaptureDetailView({
	capture,
}: {
	capture: Parameters<typeof CaptureCard>[0]["capture"];
}) {
	const onAction = useCaptureActionHandler();
	return (
		<div className="my-2">
			<CaptureCard capture={capture} onAction={onAction} />
		</div>
	);
}

const CaptureDetailUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "capture_detail",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as
			| Parameters<typeof CaptureCard>[0]["capture"]
			| null;
		if (!data || status.type === "running")
			return (
				<ToolFallback
					toolName="capture_detail"
					args={args}
					result={result}
					status={status}
				/>
			);
		return <CaptureDetailView capture={data} />;
	},
});

const WorkItemDetailUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "work_item_detail",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as
			| Parameters<typeof WorkItemCard>[0]["item"]
			| null;
		if (!data || status.type === "running")
			return (
				<ToolFallback
					toolName="work_item_detail"
					args={args}
					result={result}
					status={status}
				/>
			);
		return (
			<div className="my-2">
				<WorkItemCard item={data} />
			</div>
		);
	},
});

const CycleOverviewUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "cycle_overview",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as
			| Parameters<typeof SprintProgressCard>[0]["cycle"]
			| null;
		if (!data || status.type === "running")
			return (
				<ToolFallback
					toolName="cycle_overview"
					args={args}
					result={result}
					status={status}
				/>
			);
		return (
			<div className="my-2">
				<SprintProgressCard cycle={data} />
			</div>
		);
	},
});

function FleetStatusView({
	rows,
}: {
	rows: Array<Parameters<typeof FleetRowCard>[0]["row"]>;
}) {
	const onAction = useFleetActionHandler();
	return (
		<div className="my-2 flex w-full flex-col gap-2">
			{rows.map((r) => (
				<FleetRowCard key={r.job_id} row={r} onAction={onAction} />
			))}
		</div>
	);
}

const FleetStatusUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "fleet_status",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as {
			rows?: Array<Parameters<typeof FleetRowCard>[0]["row"]>;
		} | null;
		if (!data || status.type === "running")
			return (
				<ToolFallback
					toolName="fleet_status"
					args={args}
					result={result}
					status={status}
				/>
			);
		return <FleetStatusView rows={data.rows ?? []} />;
	},
});

const PromoteCaptureUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "promote_capture",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as
			| (Parameters<typeof WorkItemCard>[0]["item"] & { capture_id?: string })
			| null;
		if (!data || status.type === "running")
			return (
				<ToolFallback
					toolName="promote_capture"
					args={args}
					result={result}
					status={status}
				/>
			);
		return (
			<div className="my-2">
				<WorkItemCard item={data} />
				<p className="mt-1 font-mono text-[11px] text-[var(--color-success)]">
					✓ Promoted from capture {data.capture_id}
				</p>
			</div>
		);
	},
});

const DispatchWorkItemUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "dispatch_work_item",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as {
			job_id?: string;
			agent?: string;
			work_item_id?: string;
			state?: string;
		} | null;
		if (!data || status.type === "running")
			return (
				<ToolFallback
					toolName="dispatch_work_item"
					args={args}
					result={result}
					status={status}
				/>
			);
		return (
			<div className="my-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-3">
				<p className="text-[12.5px]">
					✓ Queued <span className="font-mono">{data.work_item_id}</span> for{" "}
					<span className="font-mono text-[var(--color-brand)]">
						{data.agent}
					</span>
				</p>
				<p className="mt-1 font-mono text-[11px] text-[var(--color-foreground-muted)]">
					job_id={data.job_id}
				</p>
			</div>
		);
	},
});

const CancelJobUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "cancel_job",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as CancelJobResult | null;
		if (!data || !data.job_id || status.type === "running")
			return (
				<ToolFallback
					toolName="cancel_job"
					args={args}
					result={result}
					status={status}
				/>
			);
		return (
			<div className="my-2">
				<CancelJobCard result={data} />
			</div>
		);
	},
});

const TailLogSnapshotUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "tail_log_snapshot",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as {
			title?: string;
			lines?: string[];
			state?: string;
		} | null;
		if (!data || status.type === "running")
			return (
				<ToolFallback
					toolName="tail_log_snapshot"
					args={args}
					result={result}
					status={status}
				/>
			);
		return (
			<div className="my-2">
				<RuntimeConsoleCard
					title={data.title ?? "log"}
					lines={data.lines ?? []}
					state={
						(data.state as Parameters<typeof RuntimeConsoleCard>[0]["state"]) ??
						"connected"
					}
				/>
			</div>
		);
	},
});

const RunRemoteCheckUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "run_remote_check",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as {
			host?: string;
			command_id?: string;
			stdout?: string;
			stderr?: string;
			exit_code?: number;
			duration_ms?: number;
		} | null;
		if (!data || status.type === "running")
			return (
				<ToolFallback
					toolName="run_remote_check"
					args={args}
					result={result}
					status={status}
				/>
			);
		const ok = data.exit_code === 0;
		return (
			<div className="my-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-3">
				<div className="flex items-center justify-between text-[11.5px]">
					<span className="font-mono">
						{data.host} · {data.command_id}
					</span>
					<span
						className={
							ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"
						}
					>
						exit {data.exit_code} · {data.duration_ms}ms
					</span>
				</div>
				<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--color-foreground-muted)]">
					{data.stdout || data.stderr || "(no output)"}
				</pre>
			</div>
		);
	},
});

const HostStatusUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "host_status",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as {
			host?: string;
			load?: { "1m": number; "5m": number; "15m": number };
			memory?: { total: string; used: string; available: string };
			containers?: Array<{ name: string; cpu: string; memory: string }>;
		} | null;
		if (!data || status.type === "running")
			return (
				<ToolFallback
					toolName="host_status"
					args={args}
					result={result}
					status={status}
				/>
			);
		return (
			<div className="my-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-3">
				<div className="flex items-center justify-between text-[12.5px]">
					<span className="font-semibold">{data.host}</span>
					{data.load && (
						<span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
							load {data.load["1m"]} / {data.load["5m"]} / {data.load["15m"]}
						</span>
					)}
				</div>
				{data.memory && (
					<p className="mt-1 font-mono text-[11px] text-[var(--color-foreground-muted)]">
						mem {data.memory.used} / {data.memory.total} (avail{" "}
						{data.memory.available})
					</p>
				)}
				{data.containers && data.containers.length > 0 && (
					<ul className="mt-2 space-y-0.5 font-mono text-[11px] text-[var(--color-foreground-muted)]">
						{data.containers.slice(0, 6).map((c) => (
							<li key={c.name} className="flex justify-between gap-2">
								<span className="truncate">{c.name}</span>
								<span className="text-[var(--color-foreground-faint)]">
									{c.cpu} · {c.memory}
								</span>
							</li>
						))}
					</ul>
				)}
			</div>
		);
	},
});

const SubjectMapUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "subject_map",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as Constellation | null;
		if (!data || status.type === "running" || !data.center)
			return (
				<ToolFallback
					toolName="subject_map"
					args={args}
					result={result}
					status={status}
				/>
			);
		return <SubjectConstellationCard data={data} />;
	},
});

// ─── Memory ──────────────────────────────────────────────────────────────────
//
// `memory_search` returns the raw pgvector rows (see src/server/pg.js#
// memorySearchSql). The card surfaces title + content + score + a chip to
// open the linked work item when present. `memory_write` returns the row
// that was just persisted — small confirmation card so Franck sees what
// landed.

function useMemoryActionHandler() {
	const runtime = useThreadRuntime();
	return (workItemId: string) => {
		runtime.append({
			role: "user",
			content: [
				{
					type: "text",
					text: `Use work_item_detail with work_item_id="${workItemId}" to open it.`,
				},
			],
		});
	};
}

function MemorySearchView({ rows }: { rows: MemoryRow[] }) {
	const onOpen = useMemoryActionHandler();
	return <MemorySearchCard rows={rows} onOpenWorkItem={onOpen} />;
}

const MemorySearchUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "memory_search",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as MemoryRow[] | null;
		if (!Array.isArray(data) || status.type === "running")
			return (
				<ToolFallback
					toolName="memory_search"
					args={args}
					result={result}
					status={status}
				/>
			);
		return <MemorySearchView rows={data} />;
	},
});

const MemoryListUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "memory_list",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as MemoryRow[] | null;
		if (!Array.isArray(data) || status.type === "running")
			return (
				<ToolFallback
					toolName="memory_list"
					args={args}
					result={result}
					status={status}
				/>
			);
		return <MemorySearchView rows={data} />;
	},
});

const MemoryWriteUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "memory_write",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as MemoryWriteResult | null;
		if (!data || status.type === "running")
			return (
				<ToolFallback
					toolName="memory_write"
					args={args}
					result={result}
					status={status}
				/>
			);
		return (
			<div className="my-2">
				<MemoryWriteCard result={data} />
			</div>
		);
	},
});

// ─── GlitchTip ───────────────────────────────────────────────────────────────

function useGlitchTipActionHandler() {
	const runtime = useThreadRuntime();
	return (orgSlug: string | undefined, issueId: string) => {
		const args = orgSlug
			? `org_slug="${orgSlug}", issue_id="${issueId}"`
			: `issue_id="${issueId}"`;
		runtime.append({
			role: "user",
			content: [
				{
					type: "text",
					text: `Resolve the GlitchTip issue via glitchtip_resolve_issue with ${args}.`,
				},
			],
		});
	};
}

function GlitchTipIssueView({
	issue,
	orgSlug,
}: {
	issue: GlitchTipIssue;
	orgSlug?: string;
}) {
	const onResolve = useGlitchTipActionHandler();
	return (
		<div className="my-2">
			<GlitchTipIssueCard
				issue={issue}
				orgSlug={orgSlug}
				onResolve={(id) => onResolve(orgSlug, id)}
			/>
		</div>
	);
}

const GlitchTipGetIssueUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "glitchtip_get_issue",
	render: ({ result, args, status }) => {
		const parsed = parseToolText(result) as {
			ok?: boolean;
			issue?: GlitchTipIssue;
		} | null;
		const issue = parsed?.issue ?? null;
		const orgSlug = (args as { org_slug?: string } | undefined)?.org_slug;
		if (!issue || status.type === "running")
			return (
				<ToolFallback
					toolName="glitchtip_get_issue"
					args={args}
					result={result}
					status={status}
				/>
			);
		return <GlitchTipIssueView issue={issue} orgSlug={orgSlug} />;
	},
});

const GlitchTipResolveIssueUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "glitchtip_resolve_issue",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as GlitchTipResolutionResult | null;
		if (!data || status.type === "running")
			return (
				<ToolFallback
					toolName="glitchtip_resolve_issue"
					args={args}
					result={result}
					status={status}
				/>
			);
		return (
			<div className="my-2">
				<GlitchTipResolutionCard result={data} />
			</div>
		);
	},
});

// ─── Plane pages + attachments ───────────────────────────────────────────────

function usePagesActionHandler() {
	const runtime = useThreadRuntime();
	return (project: string | undefined, pageId: string) => {
		const args = project
			? `project="${project}", page_id="${pageId}"`
			: `page_id="${pageId}"`;
		runtime.append({
			role: "user",
			content: [
				{
					type: "text",
					text: `Use plane_get_page_html with ${args} to read the body.`,
				},
			],
		});
	};
}

function PageListView({
	pages,
	project,
}: {
	pages: PlanePage[];
	project?: string;
}) {
	const onOpen = usePagesActionHandler();
	return (
		<div className="my-2">
			<PageListCard
				pages={pages}
				project={project}
				onOpen={(id) => onOpen(project, id)}
			/>
		</div>
	);
}

const PlaneListPagesUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "plane_list_pages",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as
			| { pages?: PlanePage[]; ok?: boolean }
			| PlanePage[]
			| null;
		const pages = Array.isArray(data) ? data : (data?.pages ?? null);
		const project = (args as { project?: string } | undefined)?.project;
		if (!pages || status.type === "running")
			return (
				<ToolFallback
					toolName="plane_list_pages"
					args={args}
					result={result}
					status={status}
				/>
			);
		return <PageListView pages={pages} project={project} />;
	},
});

const PlaneGetPageUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "plane_get_page",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as
			| (PlanePageContent & { ok?: boolean })
			| { ok?: boolean; page?: PlanePageContent }
			| null;
		const page =
			data && "page" in data
				? (data as { page?: PlanePageContent }).page
				: (data as PlanePageContent | null);
		if (!page || status.type === "running")
			return (
				<ToolFallback
					toolName="plane_get_page"
					args={args}
					result={result}
					status={status}
				/>
			);
		return (
			<div className="my-2">
				<PageContentCard page={page} />
			</div>
		);
	},
});

const PlaneGetPageHtmlUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "plane_get_page_html",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as {
			ok?: boolean;
			description_html?: string;
			html?: string;
			id?: string;
			name?: string;
		} | null;
		if (!data || status.type === "running")
			return (
				<ToolFallback
					toolName="plane_get_page_html"
					args={args}
					result={result}
					status={status}
				/>
			);
		const page: PlanePageContent = {
			id: data.id,
			name: data.name,
			description_html: data.description_html ?? data.html,
		};
		return (
			<div className="my-2">
				<PageContentCard page={page} />
			</div>
		);
	},
});

function planePageMutationUI(
	toolName: string,
	action: PageMutationResult["action"],
) {
	return makeAssistantToolUI<unknown, unknown>({
		toolName,
		render: ({ result, args, status }) => {
			const data = parseToolText(result) as PageMutationResult | null;
			if (!data || status.type === "running")
				return (
					<ToolFallback
						toolName={toolName}
						args={args}
						result={result}
						status={status}
					/>
				);
			return (
				<div className="my-2">
					<PageMutationCard
						result={{ ...data, action: data.action ?? action }}
					/>
				</div>
			);
		},
	});
}

const PlaneCreatePageUI = planePageMutationUI("plane_create_page", "created");
const PlaneUpdatePageUI = planePageMutationUI("plane_update_page", "updated");
const PlaneUpdatePageContentUI = planePageMutationUI(
	"plane_update_page_content",
	"updated",
);
const PlaneArchivePageUI = planePageMutationUI(
	"plane_archive_page",
	"archived",
);
const PlaneDeletePageUI = planePageMutationUI("plane_delete_page", "deleted");

function useAttachmentActionHandler() {
	const runtime = useThreadRuntime();
	return (workItemId: string, attachmentId: string) => {
		runtime.append({
			role: "user",
			content: [
				{
					type: "text",
					text: `Use plane_download_attachment with work_item_id="${workItemId}", attachment_id="${attachmentId}" to fetch it.`,
				},
			],
		});
	};
}

function AttachmentListView({
	attachments,
	workItemId,
}: {
	attachments: PlaneAttachment[];
	workItemId?: string;
}) {
	const onDownload = useAttachmentActionHandler();
	return (
		<div className="my-2">
			<AttachmentListCard
				attachments={attachments}
				onDownload={(aid) => workItemId && onDownload(workItemId, aid)}
			/>
		</div>
	);
}

const PlaneListAttachmentsUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "plane_list_attachments",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as
			| { attachments?: PlaneAttachment[]; ok?: boolean }
			| PlaneAttachment[]
			| null;
		const list = Array.isArray(data) ? data : (data?.attachments ?? null);
		const workItemId = (args as { work_item_id?: string } | undefined)
			?.work_item_id;
		if (!list || status.type === "running")
			return (
				<ToolFallback
					toolName="plane_list_attachments"
					args={args}
					result={result}
					status={status}
				/>
			);
		return <AttachmentListView attachments={list} workItemId={workItemId} />;
	},
});

// ─── Transcript ──────────────────────────────────────────────────────────────

function transcriptUI(toolName: string) {
	return makeAssistantToolUI<unknown, unknown>({
		toolName,
		render: ({ result, args, status }) => {
			const data = parseToolText(result) as
				| TranscriptRow[]
				| { rows?: TranscriptRow[] }
				| null;
			const rows = Array.isArray(data) ? data : (data?.rows ?? null);
			if (!rows || status.type === "running")
				return (
					<ToolFallback
						toolName={toolName}
						args={args}
						result={result}
						status={status}
					/>
				);
			return (
				<div className="my-2">
					<TranscriptCard rows={rows} />
				</div>
			);
		},
	});
}

const TranscriptSearchUI = transcriptUI("transcript_search");
const TranscriptRangeUI = transcriptUI("transcript_range");
const TranscriptReplayRecentUI = transcriptUI("transcript_replay_recent");

// ─── Workflows ───────────────────────────────────────────────────────────────

function useWorkflowActionHandler() {
	const runtime = useThreadRuntime();
	return (instanceId: string) => {
		runtime.append({
			role: "user",
			content: [
				{
					type: "text",
					text: `Show me the last 50 lines of workflow instance ${instanceId} via tail_log_snapshot.`,
				},
			],
		});
	};
}

function WorkflowInstancesView({
	instances,
}: {
	instances: WorkflowInstance[];
}) {
	const onTail = useWorkflowActionHandler();
	return <WorkflowInstancesCard instances={instances} onTail={onTail} />;
}

const WorkflowListInstancesUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "devpanel_workflow_list_instances",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as
			| { instances?: WorkflowInstance[]; ok?: boolean }
			| WorkflowInstance[]
			| null;
		const instances = Array.isArray(data) ? data : (data?.instances ?? null);
		if (!instances || status.type === "running")
			return (
				<ToolFallback
					toolName="devpanel_workflow_list_instances"
					args={args}
					result={result}
					status={status}
				/>
			);
		return <WorkflowInstancesView instances={instances} />;
	},
});

const WorkflowDispatchUI = makeAssistantToolUI<unknown, unknown>({
	toolName: "devpanel_workflow_dispatch",
	render: ({ result, args, status }) => {
		const data = parseToolText(result) as WorkflowDispatchResult | null;
		if (!data || status.type === "running")
			return (
				<ToolFallback
					toolName="devpanel_workflow_dispatch"
					args={args}
					result={result}
					status={status}
				/>
			);
		return (
			<div className="my-2">
				<WorkflowDispatchCard result={data} />
			</div>
		);
	},
});

// ─── @devpanl/chat-renderer dispatch (DEVPA-218) ────────────────────────────
//
// The renderer payload schema in `lib/chat-renderer-types.ts` is the
// extensible surface every future capability targets. Rather than
// registering one `makeAssistantToolUI` per type and forcing each new
// capability to also touch this file, we expose a single component that
// dispatches on the payload's discriminator. Any capability whose handler
// returns a `RendererPayload`-shaped object — directly, or under a
// `payload` key — will render the right card automatically.
//
// Concretely:
//   - DEVPA-219 (Engine tab) will wire `error-halt` and `terminal-session`
//     payloads from running jobs into this dispatcher.
//   - DEVPA-220 (react-canvas) replaces the placeholder ReactCanvasCard
//     with the live esbuild-wasm renderer; the dispatch path here doesn't
//     change.
//   - Any capability that emits a structured chip set ("inline-actions"),
//     a queue, or a job-status snapshot gets a card for free.

/**
 * Default dashboard registry — binds every payload type to its richest
 * card. Surfaces with a smaller bundle budget (the React widget Shelly)
 * pass a subset; unhandled types fall through to a one-line muted
 * placeholder, never crash.
 */
export const DASHBOARD_RENDERER_REGISTRY: RendererRegistry = {
	"job-status": ({ payload }: { payload: RendererPayload }) =>
		payload.type === "job-status" ? <JobStatusCard job={payload} /> : null,
	"console-stream": ({ payload }: { payload: RendererPayload }) =>
		payload.type === "console-stream" ? (
			<ConsoleStreamCard stream={payload} />
		) : null,
	"terminal-session": ({ payload }: { payload: RendererPayload }) =>
		payload.type === "terminal-session" ? (
			<TerminalSessionCard session={payload} />
		) : null,
	"error-halt": ({ payload }: { payload: RendererPayload }) =>
		payload.type === "error-halt" ? <ErrorHaltCard halt={payload} /> : null,
	"inline-actions": ({ payload }: { payload: RendererPayload }) =>
		payload.type === "inline-actions" ? (
			<InlineActionsCard prompt={payload.prompt} actions={payload.actions} />
		) : null,
	"react-canvas": ({ payload }: { payload: RendererPayload }) =>
		payload.type === "react-canvas" ? (
			<ReactCanvasCard canvas={payload} />
		) : null,
	"queue-card": ({ payload }: { payload: RendererPayload }) =>
		payload.type === "queue-card" ? <QueueCard queue={payload} /> : null,
};

/**
 * Dispatch a RendererPayload to the right card via a host-supplied registry.
 * Defaults to DASHBOARD_RENDERER_REGISTRY. Returns null (not a crash) when
 * the registry has no entry for the payload's type — keeps the chat stream
 * resilient to schema additions that ship before the host updates.
 */
export function RendererPayloadView({
	payload,
	registry = DASHBOARD_RENDERER_REGISTRY,
}: {
	payload: RendererPayload;
	registry?: RendererRegistry;
}) {
	const Component = registry[payload.type];
	if (!Component) {
		return (
			<p className="my-2 font-mono text-[11px] text-[var(--color-foreground-faint)]">
				(renderer: no host binding for {payload.type})
			</p>
		);
	}
	return <Component payload={payload} />;
}

// Re-export the shared extractor so app code keeps the single import site.
export const extractRendererPayload = sharedExtractRendererPayload;

// A registry entry that opportunistically renders any tool result whose
// shape matches a RendererPayload variant — without binding to a single
// `toolName`. The chat infra calls `makeAssistantToolUI` per name, so we
// can't register a wildcard here; instead, the helpers above are exposed
// for individual UI handlers (or app/assistant.tsx) to plug into when a
// capability is meant to render via this path.

// ─── Mounted as a React tree under <ToolUIRegistry /> in app/assistant.tsx ───

export function ToolUIRegistry() {
	return (
		<>
			<TriageInboxUI />
			<CaptureListUI />
			<CaptureDetailUI />
			<WorkItemDetailUI />
			<CycleOverviewUI />
			<FleetStatusUI />
			<PromoteCaptureUI />
			<DispatchWorkItemUI />
			<CancelJobUI />
			<TailLogSnapshotUI />
			<RunRemoteCheckUI />
			<HostStatusUI />
			<SubjectMapUI />
			<MemorySearchUI />
			<MemoryListUI />
			<MemoryWriteUI />
			<GlitchTipGetIssueUI />
			<GlitchTipResolveIssueUI />
			<PlaneListPagesUI />
			<PlaneGetPageUI />
			<PlaneGetPageHtmlUI />
			<PlaneCreatePageUI />
			<PlaneUpdatePageUI />
			<PlaneUpdatePageContentUI />
			<PlaneArchivePageUI />
			<PlaneDeletePageUI />
			<PlaneListAttachmentsUI />
			<TranscriptSearchUI />
			<TranscriptRangeUI />
			<TranscriptReplayRecentUI />
			<WorkflowListInstancesUI />
			<WorkflowDispatchUI />
		</>
	);
}
