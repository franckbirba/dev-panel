"use client";

import { makeAssistantToolUI, useThreadRuntime } from "@assistant-ui/react";
import {
  WorkItemCard,
  CaptureCard,
  FleetRowCard,
  RuntimeConsoleCard,
  SprintProgressCard,
  SubjectConstellationCard,
  JobStatusCard,
  ConsoleStreamCard,
  TerminalSessionCard,
  ErrorHaltCard,
  InlineActionsCard,
  ReactCanvasCard,
  QueueCard,
  type Constellation,
} from "@/components/devpanl";
import {
  parseRendererPayload,
  type RendererPayload,
} from "@/lib/chat-renderer-types";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";

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
  const content = r.content as Array<{ type: string; text?: string }> | undefined;
  const text = content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─── Capability renderers ────────────────────────────────────────────────────

function TriageInboxView({ data }: { data: { total_new?: number; by_project?: Record<string, number>; captures?: Array<Parameters<typeof CaptureCard>[0]["capture"]> } }) {
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
    const data = parseToolText(result) as
      | {
          total_new?: number;
          by_project?: Record<string, number>;
          captures?: Array<Parameters<typeof CaptureCard>[0]["capture"]>;
        }
      | null;
    if (!data || status.type === "running")
      return <ToolFallback toolName="triage_inbox" args={args} result={result} status={status} />;
    return <TriageInboxView data={data} />;
  },
});

function CaptureListView({ captures }: { captures: Array<Parameters<typeof CaptureCard>[0]["capture"]> }) {
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
    const data = parseToolText(result) as
      | { captures?: Array<Parameters<typeof CaptureCard>[0]["capture"]> }
      | null;
    if (!data || status.type === "running")
      return <ToolFallback toolName="capture_list" args={args} result={result} status={status} />;
    return <CaptureListView captures={data.captures ?? []} />;
  },
});

function CaptureDetailView({ capture }: { capture: Parameters<typeof CaptureCard>[0]["capture"] }) {
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
      return <ToolFallback toolName="capture_detail" args={args} result={result} status={status} />;
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
      return <ToolFallback toolName="work_item_detail" args={args} result={result} status={status} />;
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
      return <ToolFallback toolName="cycle_overview" args={args} result={result} status={status} />;
    return (
      <div className="my-2">
        <SprintProgressCard cycle={data} />
      </div>
    );
  },
});

const FleetStatusUI = makeAssistantToolUI<unknown, unknown>({
  toolName: "fleet_status",
  render: ({ result, args, status }) => {
    const data = parseToolText(result) as
      | { rows?: Array<Parameters<typeof FleetRowCard>[0]["row"]> }
      | null;
    if (!data || status.type === "running")
      return <ToolFallback toolName="fleet_status" args={args} result={result} status={status} />;
    return (
      <div className="my-2 flex w-full flex-col gap-2">
        {(data.rows ?? []).map((r) => (
          <FleetRowCard key={r.job_id} row={r} />
        ))}
      </div>
    );
  },
});

const PromoteCaptureUI = makeAssistantToolUI<unknown, unknown>({
  toolName: "promote_capture",
  render: ({ result, args, status }) => {
    const data = parseToolText(result) as
      | (Parameters<typeof WorkItemCard>[0]["item"] & { capture_id?: string })
      | null;
    if (!data || status.type === "running")
      return <ToolFallback toolName="promote_capture" args={args} result={result} status={status} />;
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
    const data = parseToolText(result) as
      | { job_id?: string; agent?: string; work_item_id?: string; state?: string }
      | null;
    if (!data || status.type === "running")
      return <ToolFallback toolName="dispatch_work_item" args={args} result={result} status={status} />;
    return (
      <div className="my-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-3">
        <p className="text-[12.5px]">
          ✓ Queued <span className="font-mono">{data.work_item_id}</span> for{" "}
          <span className="font-mono text-[var(--color-brand)]">{data.agent}</span>
        </p>
        <p className="mt-1 font-mono text-[11px] text-[var(--color-foreground-muted)]">
          job_id={data.job_id}
        </p>
      </div>
    );
  },
});

const TailLogSnapshotUI = makeAssistantToolUI<unknown, unknown>({
  toolName: "tail_log_snapshot",
  render: ({ result, args, status }) => {
    const data = parseToolText(result) as
      | { title?: string; lines?: string[]; state?: string }
      | null;
    if (!data || status.type === "running")
      return <ToolFallback toolName="tail_log_snapshot" args={args} result={result} status={status} />;
    return (
      <div className="my-2">
        <RuntimeConsoleCard
          title={data.title ?? "log"}
          lines={data.lines ?? []}
          state={(data.state as Parameters<typeof RuntimeConsoleCard>[0]["state"]) ?? "connected"}
        />
      </div>
    );
  },
});

const RunRemoteCheckUI = makeAssistantToolUI<unknown, unknown>({
  toolName: "run_remote_check",
  render: ({ result, args, status }) => {
    const data = parseToolText(result) as
      | {
          host?: string;
          command_id?: string;
          stdout?: string;
          stderr?: string;
          exit_code?: number;
          duration_ms?: number;
        }
      | null;
    if (!data || status.type === "running")
      return <ToolFallback toolName="run_remote_check" args={args} result={result} status={status} />;
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
    const data = parseToolText(result) as
      | {
          host?: string;
          load?: { "1m": number; "5m": number; "15m": number };
          memory?: { total: string; used: string; available: string };
          containers?: Array<{ name: string; cpu: string; memory: string }>;
        }
      | null;
    if (!data || status.type === "running")
      return <ToolFallback toolName="host_status" args={args} result={result} status={status} />;
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
            mem {data.memory.used} / {data.memory.total} (avail {data.memory.available})
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
      return <ToolFallback toolName="subject_map" args={args} result={result} status={status} />;
    return <SubjectConstellationCard data={data} />;
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

export function RendererPayloadView({ payload }: { payload: RendererPayload }) {
  switch (payload.type) {
    case "job-status":
      return <JobStatusCard job={payload} />;
    case "console-stream":
      return <ConsoleStreamCard stream={payload} />;
    case "terminal-session":
      return <TerminalSessionCard session={payload} />;
    case "error-halt":
      return <ErrorHaltCard halt={payload} />;
    case "inline-actions":
      return (
        <InlineActionsCard prompt={payload.prompt} actions={payload.actions} />
      );
    case "react-canvas":
      return <ReactCanvasCard canvas={payload} />;
    case "queue-card":
      return <QueueCard queue={payload} />;
  }
}

/**
 * Extract a RendererPayload from an arbitrary tool result. Looks for the
 * payload in three positions: (a) the result itself, (b) a top-level
 * `payload` key, (c) inside the existing `__capability`-tagged envelope
 * under `payload`. Returns null if no variant matches.
 */
export function extractRendererPayload(result: unknown): RendererPayload | null {
  const direct = parseRendererPayload(result);
  if (direct) return direct;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if ("payload" in r) {
      const nested = parseRendererPayload(r.payload);
      if (nested) return nested;
    }
  }
  return null;
}

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
      <TailLogSnapshotUI />
      <RunRemoteCheckUI />
      <HostStatusUI />
      <SubjectMapUI />
    </>
  );
}
