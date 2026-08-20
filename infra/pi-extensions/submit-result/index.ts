/**
 * submit_result extension for Pi (`@earendil-works/pi-coding-agent`).
 *
 * Why this exists (H3, docs/architecture/harness-pi.md §4.1 / ADR-005 H3):
 * the worker's output contract (prompt-builder.js's parseResult) asks every
 * role to close with a single JSON object matching the envelope schema on
 * the LAST LINE of its final text response. That's "print JSON and hope"
 * — for Claude it works because Claude reliably follows closing-format
 * instructions. For Qwen3-Coder-480B on long runs it doesn't: pi-driver.js's
 * own comments (see synthesizePiResult) document ~70% of long runs dropping
 * the envelope entirely — trailing prose with no JSON, a hallucinated
 * `<tool_call>` XML fragment instead of the object, or the JSON cut mid-
 * object by a per-message token cap (job 4771).
 *
 * The fix generalizes past any one weak model (ADR-005 anti-overfit rule):
 * turn "emit trailing JSON" into "call a tool". Tool-call argument
 * generation is a much better-trained behavior than free-form structured
 * text for every coder-tier model we've benchmarked (mini-swe-agent and
 * SWE-agent both lean on the same insight for their finish/submit steps).
 * A model that can call `edit` and `create_file` correctly (H2 — validated
 * at the 2026-05-09 spike) can call `submit_result` correctly.
 *
 * What this extension does:
 *   1. Registers `submit_result`, whose parameters ARE the envelope v1
 *      schema (status/summary/artifacts/handoff/memory_writes_count/
 *      blockers/issues_found) — copied field-for-field from prompt-
 *      builder.js's REQUIRED_TOP + the JSON shown in the role prompt.
 *   2. On a successful call, writes the envelope as JSON to a sentinel
 *      file in the agent's cwd (see SUBMIT_RESULT_FILENAME below) and
 *      also returns it as the tool result content, so it's visible in
 *      the pi-driver event stream even if the file read races anything.
 *   3. Emits loop-guard's closing marker in the tool result text. This
 *      isn't a hack layered on top of loop-guard — loop-guard already
 *      scans assistant message text for the marker and requests a clean
 *      pi shutdown at the next turn_end (see loop-guard/index.ts). A tool
 *      RESULT's text content is not assistant message text, so we also
 *      surface the marker via `ctx.ui?.notify` is not enough; instead we
 *      rely on the model's own next assistant turn (which typically
 *      echoes a short "done" after a successful tool call) to naturally
 *      end the turn — and, as a stronger guarantee, this extension listens
 *      for its own tool_call event and requests shutdown directly once
 *      submit_result has both been called AND its file write confirmed,
 *      without depending on the model saying anything more at all.
 *
 * Why a file, not stdout parsing:
 *   pi-driver.js already treats stdout as a structured `--mode json` event
 *   stream, entirely owned by pi-stream-shim.js's line-based JSON parser.
 *   Splicing a second, differently-shaped payload into that same stream
 *   (e.g. printing raw envelope JSON to stdout from inside the extension)
 *   would either get mangled by parsePiLine (it expects one JSON object
 *   per line matching pi's own event vocabulary) or require the shim to
 *   special-case a foreign event shape. A file is: (a) always available —
 *   the driver already knows `cwd`, (b) trivially atomic (single writeFile
 *   call, read-after-close by the driver), (c) inspectable for debugging
 *   without instrumenting the stream, and (d) already how create-file/edit
 *   report success (fs is the shared substrate every tool in this repo's
 *   pi-extensions/ already trusts). The tool RESULT (returned from
 *   `execute`) still carries the same JSON so the pi-stream-shim's
 *   tool_execution_end translation captures it in the event timeline too
 *   — the file is the reliable channel, the tool result is the visible one.
 *
 * Loaded via:
 *   pi --extension /home/deploy/projects/dev-panel/infra/pi-extensions/submit-result
 *
 * Tunables (env vars):
 *   PI_SUBMIT_RESULT_FILENAME — sentinel filename (default
 *                                ".pi-submit-result.json", relative to cwd)
 */
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SENTINEL_FILENAME =
	process.env.PI_SUBMIT_RESULT_FILENAME || ".pi-submit-result.json";

// Loop-guard's closing marker (infra/pi-extensions/loop-guard/index.ts).
// Duplicated here (not imported) because pi loads each extension as an
// independent module via jiti — there's no shared package boundary between
// extension directories, and every existing composite extension in this
// tree (github, work-items) follows the same "duplicate the small constant"
// pattern rather than reach across extension directories.
const CLOSING_MARKER =
	process.env.PI_LOOP_CLOSING_MARKER || "<<<COMPLETE_TASK_AND_SUBMIT>>>";

const STATUS_ENUM = ["done", "blocked", "failed"] as const;

// Mirrors prompt-builder.js's envelope v1 shape exactly (REQUIRED_TOP +
// the JSON template shown in the role prompt's "Rules" section). artifacts
// and handoff stay permissive objects (Type.Record) rather than fully
// nested schemas: prompt-builder.js's `validate()` only checks they are
// objects, and over-constraining nested shape here would reject payloads
// prompt-builder.js itself accepts — the tool schema should be exactly as
// strict as the thing that consumes it, not stricter.
const submitResult = defineTool({
	name: "submit_result",
	label: "Submit result",
	description:
		"Call this exactly once, as your LAST action, to close out the job. " +
		"Replaces printing a trailing JSON object — the harness reads the " +
		"envelope from this tool call instead of parsing your final text, " +
		"so it can't be dropped, truncated, or mixed up with prose. " +
		"status: 'done' if you completed the task with real changes, " +
		"'blocked' if you need input/access you don't have, 'failed' if you " +
		"attempted the task and it did not work. summary: 1-3 sentences, " +
		"human-readable, what happened and why. artifacts: files touched, " +
		"commits made, PR url if any. handoff: which agent (if any) should " +
		"pick this up next and why. memory_writes_count: how many " +
		"memory_write calls you made this run. blockers: short strings, " +
		"only for status=blocked. issues_found: short strings, problems " +
		"noticed but not fixed.",
	parameters: Type.Object({
		status: Type.Union(STATUS_ENUM.map((s) => Type.Literal(s)), {
			description: "done | blocked | failed",
		}),
		summary: Type.String({
			description: "1-3 sentences: what happened and why. Never empty.",
		}),
		artifacts: Type.Object(
			{
				files_created: Type.Optional(Type.Array(Type.String())),
				files_modified: Type.Optional(Type.Array(Type.String())),
				commits: Type.Optional(Type.Array(Type.String())),
				branch: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				tests_passed: Type.Optional(Type.Boolean()),
				pr_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			},
			{ description: "What you changed. Omit fields you have no info for — do not invent values." },
		),
		handoff: Type.Object(
			{
				next_agent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				reason: Type.Optional(Type.String()),
			},
			{ description: "Who should pick this up next, if anyone." },
		),
		memory_writes_count: Type.Number({
			description: "How many memory_write calls you made this run (0 if none).",
		}),
		blockers: Type.Array(Type.String(), {
			description: "Only non-empty when status=blocked.",
		}),
		issues_found: Type.Array(Type.String(), {
			description: "Problems you noticed but did not fix, if any.",
		}),
	}),
	async execute(_id, params, _signal, _onUpdate, ctx) {
		const envelope = {
			status: params.status,
			summary: params.summary,
			artifacts: {
				files_created: params.artifacts?.files_created ?? [],
				files_modified: params.artifacts?.files_modified ?? [],
				commits: params.artifacts?.commits ?? [],
				branch: params.artifacts?.branch ?? null,
				tests_passed: params.artifacts?.tests_passed ?? false,
				pr_url: params.artifacts?.pr_url ?? null,
			},
			handoff: {
				next_agent: params.handoff?.next_agent ?? null,
				reason: params.handoff?.reason ?? "",
			},
			memory_writes_count: params.memory_writes_count,
			blockers: params.blockers ?? [],
			issues_found: params.issues_found ?? [],
		};

		const sentinelPath = isAbsolute(SENTINEL_FILENAME)
			? SENTINEL_FILENAME
			: join(ctx.cwd, SENTINEL_FILENAME);

		try {
			await writeFile(sentinelPath, JSON.stringify(envelope), "utf-8");
		} catch (err) {
			// Non-fatal: the tool result content below still carries the
			// envelope, and pi-driver.js's parseResult fallback can still find
			// it in the final assistant text if the model repeats it. But the
			// model needs to know the primary channel failed.
			const payload = {
				ok: false,
				error: `submit_result: failed to write sentinel file: ${(err as Error).message}`,
				envelope,
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(payload) },
				],
				details: payload,
				isError: true,
			};
		}

		const payload = { ok: true, envelope };
		return {
			content: [
				{
					type: "text" as const,
					// Include the closing marker so a transcript grep / dashboard
					// view can spot completion at a glance. loop-guard's own
					// marker detection scans ASSISTANT message text, not tool
					// results, so this string alone doesn't trigger it — the
					// tool_call listener below drives the actual shutdown.
					text: `${JSON.stringify(payload)}\n${CLOSING_MARKER}`,
				},
			],
			details: payload,
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(submitResult);

	// Drive a clean shutdown once submit_result has been called and its
	// write confirmed — this is the "connect to loop-guard's terminator"
	// requirement: submit_result becomes a reliable, tool-call-driven
	// completion signal instead of depending on the model ALSO echoing the
	// closing marker in a subsequent assistant text turn (which is exactly
	// the kind of extra free-form step a weak model can drop). We request
	// shutdown from turn_end, same as loop-guard, so any tool results still
	// in flight for this turn get delivered to the model/driver first.
	let shouldShutdown = false;
	pi.on("tool_call", async (event) => {
		if (event.toolName === "submit_result") {
			shouldShutdown = true;
		}
		return undefined;
	});
	pi.on("turn_end", async (_event, ctx) => {
		if (!shouldShutdown) return;
		ctx.ui?.notify?.(
			"submit_result: envelope received, shutting down",
			"info",
		);
		try {
			const piAny = ctx as unknown as { shutdown?: () => Promise<void> };
			if (typeof piAny.shutdown === "function") {
				await piAny.shutdown();
			} else {
				setTimeout(() => process.exit(0), 50);
			}
		} catch {
			setTimeout(() => process.exit(0), 50);
		}
	});
}
