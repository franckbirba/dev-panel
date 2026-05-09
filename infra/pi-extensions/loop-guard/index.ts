/**
 * Loop-guard extension for Pi (`@earendil-works/pi-coding-agent`).
 *
 * Two pure-mechanism safety nets to compensate for model-tier weaknesses
 * (originally surfaced on the ZENO-339 canary 2026-05-09: Qwen3-Coder-480B
 * looped 24× retrying the same broken `gh pr create` shell-quoting):
 *
 *  1. **Repetition guard.** If the model issues the same tool call (same
 *     name + same input) more than REPEAT_THRESHOLD times in a row, block
 *     subsequent calls with a redirecting error message. Forces the model
 *     to try a different approach instead of burning cost on identical
 *     retries.
 *
 *  2. **Closing protocol.** If the model's text emits a magic marker
 *     (`<<<COMPLETE_TASK_AND_SUBMIT>>>` by default), trigger a clean
 *     shutdown after the current turn. This is the structural equivalent
 *     of mini-swe-agent's COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT — the
 *     harness, not the model, decides when work is done.
 *
 * Both gates are non-invasive: when not triggered, they're zero-overhead
 * event observers. They never block on the first occurrence — the model
 * gets several chances to recover before we step in.
 *
 * Loaded via:
 *   pi --extension /home/deploy/projects/dev-panel/infra/pi-extensions/loop-guard
 *
 * Tunables (env vars, optional):
 *   PI_LOOP_REPEAT_THRESHOLD  — repetitions before blocking (default 3)
 *   PI_LOOP_CLOSING_MARKER    — magic string for closing protocol
 *                               (default "<<<COMPLETE_TASK_AND_SUBMIT>>>")
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REPEAT_THRESHOLD = Number(process.env.PI_LOOP_REPEAT_THRESHOLD || "3");
const CLOSING_MARKER =
	process.env.PI_LOOP_CLOSING_MARKER || "<<<COMPLETE_TASK_AND_SUBMIT>>>";

interface CallSignature {
	tool: string;
	inputHash: string;
}

/** Stable hash of a tool call for repetition detection. */
function callSignature(toolName: string, input: unknown): CallSignature {
	// JSON.stringify with sorted keys to make the hash key-order-independent.
	const sortedKeys = (obj: unknown): unknown => {
		if (obj === null || typeof obj !== "object") return obj;
		if (Array.isArray(obj)) return obj.map(sortedKeys);
		const o = obj as Record<string, unknown>;
		return Object.keys(o)
			.sort()
			.reduce<Record<string, unknown>>((acc, k) => {
				acc[k] = sortedKeys(o[k]);
				return acc;
			}, {});
	};
	return {
		tool: toolName,
		inputHash: JSON.stringify(sortedKeys(input)),
	};
}

export default function (pi: ExtensionAPI) {
	// State shared across all events in this extension.
	const recent: CallSignature[] = []; // sliding window of tool-call sigs
	let closingRequested = false;

	pi.on("tool_call", async (event, ctx) => {
		const sig = callSignature(event.toolName, event.input);

		// Count consecutive identical calls at the tail of the window.
		let consecutive = 1;
		for (let i = recent.length - 1; i >= 0; i--) {
			if (
				recent[i].tool === sig.tool &&
				recent[i].inputHash === sig.inputHash
			) {
				consecutive++;
			} else {
				break;
			}
		}
		recent.push(sig);
		// Keep window bounded — REPEAT_THRESHOLD * 4 is plenty.
		if (recent.length > REPEAT_THRESHOLD * 4) recent.shift();

		if (consecutive > REPEAT_THRESHOLD) {
			const reason =
				`[loop-guard] same ${event.toolName} call repeated ${consecutive} times ` +
				`with identical input (hash=${sig.inputHash.slice(0, 80)}...). ` +
				`Stop retrying the same command — try a different approach. ` +
				`If a shell command keeps failing on quoting, use a structured ` +
				`tool instead (e.g., gh_pr_create with title+body strings instead ` +
				`of \`gh pr create\` via bash). Re-running the exact same call ` +
				`will be blocked by the harness, not just refused by the OS.`;
			ctx.ui?.notify?.(
				`loop-guard: blocking ${event.toolName} after ${consecutive} identical retries`,
				"warning",
			);
			return { block: true, reason };
		}
		return undefined;
	});

	pi.on("message_end", async (event, ctx) => {
		// Look at the text content of assistant messages for the closing
		// marker. We don't *return* anything here — message_end can replace
		// the message but cannot stop the loop. Instead we set a flag that
		// the next turn_end will act on.
		if (event.message?.role !== "assistant") return undefined;
		const text =
			(event.message.content as Array<{ type?: string; text?: string }> | undefined)
				?.filter((c) => c?.type === "text")
				?.map((c) => c.text || "")
				?.join("\n") ?? "";
		if (text.includes(CLOSING_MARKER)) {
			closingRequested = true;
			ctx.ui?.notify?.(
				`loop-guard: closing marker detected — agent will exit at turn end`,
				"info",
			);
		}
		return undefined;
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!closingRequested) return;
		// Honor the closing marker. ctx.shutdown() requests graceful pi exit;
		// the parent worker (dev-panel pi-driver) sees the process close and
		// resolves with the last assistant text — which contains the marker
		// AND (typically) the final result JSON the model emitted before it.
		ctx.ui?.notify?.(`loop-guard: triggering shutdown`, "info");
		try {
			// shutdown is on ExtensionAPI per the docs but typing isn't fully
			// exposed; fall back to process.exit if not available.
			const piAny = ctx as unknown as { shutdown?: () => Promise<void> };
			if (typeof piAny.shutdown === "function") {
				await piAny.shutdown();
			} else {
				// Last resort — tell pi to wrap up. exit code 0 is fine; the
				// harness reads the trailing JSON from stdout, not the exit code.
				setTimeout(() => process.exit(0), 50);
			}
		} catch {
			setTimeout(() => process.exit(0), 50);
		}
	});
}
