// chat-renderer-types — discriminated union of every rich card the chat
// surface can render in response to a tool call. This is the contract
// every capability targets: emit a payload whose shape matches one of
// these variants, the registry binds the right React card, done.
//
// Why TypeScript discriminated unions instead of a separate Zod package
// (per the DEVPA-218 brief): the existing tool-ui-registry parses
// `result.content[0].text` defensively at runtime and falls back to
// ToolFallback on shape drift, so runtime validation is already covered
// at the boundary. TS at compile time + defensive parse at the seam is
// what the codebase converged to; respecting that convention keeps the
// contract in one file the LLM and humans can both grok.
//
// The runtime parser lives in `src/packages/chat-renderer/parser.js` so
// the widget (plain JS, Vite bundle) and the dashboard (TS, Next bundle)
// share one implementation. This file owns the *types* and re-exports
// the runtime so existing imports stay green (DEVPA-210).

import {
	extractRendererPayload as extractRendererPayloadRuntime,
	parseRendererPayload as parseRendererPayloadRuntime,
	RENDERER_PAYLOAD_TYPES as RUNTIME_PAYLOAD_TYPES,
} from "../../../src/packages/chat-renderer/parser.js";

// ─── Shared primitives ──────────────────────────────────────────────────

export type Severity = "trace" | "info" | "warn" | "error" | "sync";

export type JobState =
	| "queued"
	| "running"
	| "success"
	| "failed"
	| "blocked"
	| "cancelled";

export interface InlineActionChip {
	/** Stable id used by handlers + analytics. */
	id: string;
	/** Short label rendered on the chip. 1–3 words. */
	label: string;
	/** Optional payload posted back as a user turn when clicked. Same
	 *  contract as Telegram inline-keyboard callback_data. */
	payload?: string;
	/** Optional variant for emphasis — defaults to "default". */
	variant?: "default" | "primary" | "danger";
}

// ─── Variant payloads ───────────────────────────────────────────────────

/**
 * job-status — progress bar + state badge per running job.
 * Source mock: "Zeno Orchestrator" pane (Schema_Builder_v4 72%, …).
 */
export interface JobStatusPayload {
	type: "job-status";
	job_id: string;
	/** Human-friendly name. */
	name: string;
	state: JobState;
	/** 0–100. Omit for indeterminate states. */
	progress?: number;
	/** Optional one-line status text — "Compiling 3 of 5 modules…". */
	detail?: string;
	/** Optional ISO timestamp of last update. */
	updated_at?: string;
}

/**
 * console-stream — streaming log block with severity tagging.
 * Auto-scrolls unless the user scrolled up.
 */
export interface ConsoleStreamLine {
	ts?: string;
	severity?: Severity;
	text: string;
}

export interface ConsoleStreamPayload {
	type: "console-stream";
	title: string;
	lines: ConsoleStreamLine[];
	/** Tail liveness — affects the dot indicator. */
	state?: "connecting" | "connected" | "reconnecting" | "disconnected";
}

/**
 * terminal-session — live SSH/shell pane. Carries a session reference,
 * not raw bytes (those stream over a separate channel).
 */
export interface TerminalSessionPayload {
	type: "terminal-session";
	session_id: string;
	host: string;
	user?: string;
	/** Short prompt string ("deploy@hetzner:~"). */
	prompt?: string;
	/** Initial buffer to render before the live stream attaches. */
	initial_lines?: string[];
	/** Sidecar metadata — host metrics + security context. */
	metrics?: {
		load?: [number, number, number];
		memory_used?: string;
		memory_total?: string;
	};
	security?: {
		label: string;
		detail?: string;
		variant?: "ok" | "warn" | "danger";
	}[];
}

/**
 * error-halt — execution-halted card. Structured error code, message,
 * and the agent's recovery question to the user.
 */
export interface ErrorHaltPayload {
	type: "error-halt";
	/** Structured error code (e.g. "ENV_SECRET_MISSING"). */
	error_code: string;
	/** One-sentence human message. */
	message: string;
	/** Source — agent name or component that halted. */
	source?: string;
	/** The recovery question shown to the user. */
	recovery_prompt?: string;
	/** Optional chips beneath the question — wired to the inline-actions
	 *  contract so the same payload format works on Telegram + dashboard. */
	actions?: InlineActionChip[];
}

/**
 * inline-actions — standalone chip strip. Used when the LLM wants to
 * present a closed set of replies without rendering a parent card.
 */
export interface InlineActionsPayload {
	type: "inline-actions";
	prompt?: string;
	actions: InlineActionChip[];
}

/**
 * react-canvas — live React component preview with Preview/Code toggle.
 * Full rendering is DEVPA-220; the type lands here so the contract is
 * settled and capabilities can already emit it.
 */
export interface ReactCanvasSlot {
	kind: "diagram" | "image" | "table" | "chart" | "meta";
	title?: string;
	body?: string;
}

export interface ReactCanvasPayload {
	type: "react-canvas";
	filename?: string;
	/** TSX source. Compiled+sandboxed by the renderer in DEVPA-220. */
	tsx: string;
	/** Allowed deps the sandbox should resolve. Validated against an
	 *  allowlist server-side before stream. */
	deps?: string[];
	/** Theme tokens read from the host registry — keys, not values. */
	theme?: string[];
	slots?: ReactCanvasSlot[];
	/** Reported bundle size in bytes (post-compile). */
	bundle_size?: number;
}

/**
 * queue-card — pending-items list with status per item.
 * Source mock: ENV INJECTION QUEUE.
 */
export interface QueueItem {
	id: string;
	label: string;
	state: "pending" | "waiting_for_input" | "approved" | "rejected" | "expired";
	detail?: string;
	/** Per-item chips (e.g. "Approve" / "Reject"). */
	actions?: InlineActionChip[];
}

export interface QueueCardPayload {
        type: "queue-card";
        title: string;
        items: QueueItem[];
        /** Optional summary footer. */
        footer?: string;
}

/**
 * subject-constellation — the studio graph neighborhood card.
 * Centers on one subject and shows its immediate typed connections.
 */
export interface SubjectConstellationPayload {
        type: "subject-constellation";
        center: {
                type: string;
                id: string;
                summary: any;
        };
        /** Neighbors grouped by their subject type. */
        groups: Record<string, Array<{
                direction: "in" | "out";
                rel: string;
                type: string;
                id: string;
                summary?: any;
                meta?: any;
        }>>;
        /** Totals per group. */
        counts: Record<string, number>;
        /** Absolute total of raw edges found. */
        edge_count: number;
        /** Captured if the traversal was partially degraded. */
        edges_error?: string | null;
}

// ─── Discriminated union + helpers ──────────────────────────────────────

export type RendererPayload =
        | JobStatusPayload
        | ConsoleStreamPayload
        | TerminalSessionPayload
        | ErrorHaltPayload
        | InlineActionsPayload
        | ReactCanvasPayload
        | QueueCardPayload
        | SubjectConstellationPayload;
export type RendererPayloadType = RendererPayload["type"];

export const RENDERER_PAYLOAD_TYPES =
	RUNTIME_PAYLOAD_TYPES as readonly RendererPayloadType[];

export function parseRendererPayload(input: unknown): RendererPayload | null {
	return parseRendererPayloadRuntime(input) as RendererPayload | null;
}

export function extractRendererPayload(
	result: unknown,
): RendererPayload | null {
	return extractRendererPayloadRuntime(result) as RendererPayload | null;
}

/**
 * Host registry contract. Each chat surface (dashboard, widget, future
 * whitelabel) supplies a map binding a payload type to its React component.
 * Partial — a surface can register only the cards it cares about; types not
 * present fall through to a generic ToolFallback / "unrenderable" message.
 *
 * Component type kept loose (any-component) to avoid coupling the schema
 * module to React's typings, which would force every consumer to bring
 * React in for compile.
 */
export type RendererRegistry = Partial<{
	// biome-ignore lint/suspicious/noExplicitAny: cross-surface contract
	[K in RendererPayloadType]: any;
}>;
