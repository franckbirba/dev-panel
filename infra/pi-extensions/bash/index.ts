/**
 * Bash extension for Pi (`@earendil-works/pi-coding-agent`).
 *
 * Why this exists: Pi 0.74 ships zero shell tool out of the box. Every
 * worker role whose prompt says "use bash to ..." (merge-coordinator's `gh`
 * calls, builder's `npm test`, deploy's `docker compose`) silently no-ops on
 * Pi because the model sees the instruction, finds no Bash tool, gives up,
 * and emits empty content — which `parseResult()` upstream rejects with
 * `missing field: status`. Caught live on merge-coordinator job 3029
 * (2026-05-10) where Qwen3 produced an assistant message with `content: []`.
 *
 * Tools registered:
 *   bash_exec({ command, cwd?, timeout_ms?, env? })
 *
 * Design choices:
 *  - **Single tool, not a pseudo-shell.** No interactive REPL state. Each
 *    call is a one-shot `bash -c` that captures stdout+stderr+exit. Mirrors
 *    Claude Code's Bash tool semantics so prompts written for Claude work
 *    here unchanged.
 *  - **stdout+stderr each truncated to 16KB.** Pi's context budget is small
 *    on cheap-tier models; an unbounded `find /` would blow the conversation
 *    in one call. The model gets a clear truncation marker and can re-run
 *    with a tighter command.
 *  - **120s default timeout, 600s max.** Stops runaway loops and makes
 *    failure modes obvious instead of stalling the worker job.
 *  - **No allowlist.** This is a worker subprocess running as `deploy` in a
 *    per-job worktree (`.devpanel-worktrees/<job_id>/`). If we want to gate
 *    dangerous commands, that belongs at the OS layer (deploy's sudoers,
 *    the worktree being chroot-ish), not in a permissive string-match
 *    blocklist that the model will route around.
 *  - **No shell pipefail by default.** Match Claude Code's behavior — if
 *    the role wants strict mode, they can prefix `set -eo pipefail; ...`
 *    in their command. Forcing it would surprise prompts written for
 *    Claude Code.
 *
 * Loaded via:
 *   pi --extension /home/deploy/projects/dev-panel/infra/pi-extensions/bash
 */
import { spawn } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const OUTPUT_LIMIT_BYTES = 16 * 1024;

interface BashRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	timedOut: boolean;
	durationMs: number;
}

/**
 * Run `bash -c <command>` in `cwd`. Captures stdout+stderr (each capped),
 * sends SIGTERM at the timeout (then SIGKILL 2s later if still alive).
 */
function runBash(
	command: string,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<BashRunResult> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const child = spawn("bash", ["-c", command], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		let stdout = "";
		let stderr = "";
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let timedOut = false;

		child.stdout.on("data", (c: Buffer) => {
			const remaining = OUTPUT_LIMIT_BYTES - stdout.length;
			if (remaining <= 0) {
				stdoutTruncated = true;
				return;
			}
			const piece = c.toString("utf8");
			if (piece.length <= remaining) {
				stdout += piece;
			} else {
				stdout += piece.slice(0, remaining);
				stdoutTruncated = true;
			}
		});

		child.stderr.on("data", (c: Buffer) => {
			const remaining = OUTPUT_LIMIT_BYTES - stderr.length;
			if (remaining <= 0) {
				stderrTruncated = true;
				return;
			}
			const piece = c.toString("utf8");
			if (piece.length <= remaining) {
				stderr += piece;
			} else {
				stderr += piece.slice(0, remaining);
				stderrTruncated = true;
			}
		});

		const killTimer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			// Hard kill if it ignores SIGTERM (rare for shell scripts but
			// happens with stuck native binaries).
			setTimeout(() => {
				if (!child.killed) child.kill("SIGKILL");
			}, 2000);
		}, timeoutMs);

		const onAbort = () => {
			timedOut = true;
			child.kill("SIGTERM");
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (e) => {
			clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			reject(e);
		});

		child.on("close", (code) => {
			clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			resolve({
				exitCode: code,
				stdout,
				stderr,
				stdoutTruncated,
				stderrTruncated,
				timedOut,
				durationMs: Date.now() - start,
			});
		});
	});
}

const bashExec = defineTool({
	name: "bash_exec",
	label: "Bash exec",
	description:
		"Run a shell command via `bash -c`. Captures stdout (max 16KB), stderr (max 16KB), and exit code. Default timeout 120s, max 600s. Use this for anything not covered by structured tools — git operations, ad-hoc jq, file inspection, running tests, gh-CLI calls without a structured equivalent. Each call is independent (no shell state carries over). Inherits the worker's env (GH_TOKEN, etc.); to set one-off vars, prefix the command (e.g., `CI=true npm test`). Returns JSON: { exit_code, stdout, stderr, stdout_truncated, stderr_truncated, timed_out, duration_ms }.",
	parameters: Type.Object({
		command: Type.String({
			description:
				"The bash command to run. Multi-line and pipes are fine (it runs as `bash -c '<command>'`). Quote carefully — for content with single quotes, prefer a heredoc or write to a file with another tool first.",
		}),
		cwd: Type.Optional(
			Type.String({
				description:
					"Working directory. Defaults to the agent's worktree. Only set this if you genuinely need to run somewhere else.",
			}),
		),
		timeout_ms: Type.Optional(
			Type.Number({
				description: `Timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}. The process is SIGTERM'd at the timeout (then SIGKILL 2s later).`,
			}),
		),
	}),
	async execute(_id, params, signal, _onUpdate, ctx) {
		const cwd = params.cwd ?? ctx.cwd;
		let timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
		if (timeoutMs > MAX_TIMEOUT_MS) timeoutMs = MAX_TIMEOUT_MS;
		if (timeoutMs < 1000) timeoutMs = 1000;

		try {
			const r = await runBash(params.command, cwd, timeoutMs, signal);
			const payload = {
				exit_code: r.exitCode,
				stdout: r.stdout,
				stderr: r.stderr,
				stdout_truncated: r.stdoutTruncated,
				stderr_truncated: r.stderrTruncated,
				timed_out: r.timedOut,
				duration_ms: r.durationMs,
			};
			return {
				content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
				details: payload,
				isError: r.exitCode !== 0 || r.timedOut,
			};
		} catch (e) {
			const msg = (e as Error).message;
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								exit_code: null,
								stdout: "",
								stderr: `[bash_exec] spawn failed: ${msg}`,
								stdout_truncated: false,
								stderr_truncated: false,
								timed_out: false,
								duration_ms: 0,
							},
							null,
							2,
						),
					},
				],
				isError: true,
			};
		}
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(bashExec);
}
