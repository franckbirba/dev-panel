/**
 * create-file extension for Pi (`@earendil-works/pi-coding-agent`).
 *
 * Why this exists: Pi's built-in `write(path, content)` is a Claude-tuned
 * tool — it trusts the model to serialize a coherent multi-construct source
 * file into one string parameter. Claude does this fine; Qwen3-Coder-480B
 * does not. Caught on job 4168 (DEVPA-225, 2026-05-15): Qwen3 ran 34 clean
 * tool calls of exploration, then on its first `write` call to a NEW file
 * (`src/server/oauth2.js` with 4 separate constructs — OAuth metadata, JWT
 * claims, HMAC, allowlist + routes) it degraded to a nested-array-of-Python-
 * dicts string: `[{'crypto': 'import { ...'}, {'issuer': 'https://...'}, …]`.
 * It then deleted the broken file, ran out of attempts, exited with no
 * closing JSON.
 *
 * This is a published failure mode. Aider's leaderboard shows weak coder
 * models drop ~20pp accuracy on whole-file write vs SEARCH/REPLACE edits.
 * mini-swe-agent ships SOTA on SWE-bench Lite with NO file-write tool at
 * all — only bash. SWE-agent's `str_replace_based_edit_tool` and Anthropic's
 * `str_replace_based_edit_tool` (Claude 3.5+ built-in) exist for this
 * reason.
 *
 * Our fix: hide Pi's built-in `write` via `--tools read,edit,grep,find,ls,
 * bash` allowlist on the spawn argv (see src/worker/pi-driver.js), and
 * expose this `create_file` instead with two guardrails:
 *
 *   1. Reject content with > MAX_LINES lines (default 200). Forces
 *      incremental construction: model emits a small stub, then uses Pi's
 *      built-in `edit` (which IS SEARCH/REPLACE — Aider-style) to add the
 *      rest in pieces. The `edit` tool's unique-match guarantee is far
 *      more robust against serialization drift.
 *
 *   2. Reject content that LOOKS like nested data-as-code. Specifically,
 *      content whose first non-whitespace character is `[{` or `{'`
 *      (Python-dict pseudo-JSON) or `[\n  {` patterns. This is the exact
 *      shape job 4168 produced — and it's never valid source for the
 *      languages we care about (JS/TS/Python files normally start with
 *      `import`, `const`, `function`, `class`, `#`, `//`, etc.).
 *
 *      When rejected, the error message points the model at the right
 *      alternative: "use bash_exec with `cat > path <<'EOF' ... EOF`"
 *      (heredoc keeps source as a literal multi-line block in shell,
 *      sidestepping the JSON-stringify failure mode entirely).
 *
 * Loaded via:
 *   pi --extension /home/deploy/projects/dev-panel/infra/pi-extensions/create-file
 *
 * Tunables (env vars):
 *   PI_CREATE_FILE_MAX_LINES   — line limit before forced-rejection (default 200)
 */
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { constants } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_LINES = Number(process.env.PI_CREATE_FILE_MAX_LINES || "200");

interface CreateFileError {
	ok: false;
	error: string;
	hint: string;
}

interface CreateFileSuccess {
	ok: true;
	path: string;
	bytes: number;
	lines: number;
}

/**
 * Heuristic: does this content look like a serialized pseudo-JSON dict-of-
 * code instead of real source? This is the Qwen3-on-new-file failure shape
 * (job 4168). Real source files don't open with `[{'` or `[\n  {`. The check
 * is intentionally tight — a real JS file might start with `[` (an array
 * literal as the module's first expression is rare but legal) but never
 * `[{` immediately followed by a quoted key.
 *
 * Returns the matched signature string for the error message, or null.
 */
function detectPseudoJson(content: string): string | null {
	// Skip BOM + leading whitespace.
	const trimmed = content.replace(/^\uFEFF?\s+/, "");
	// Shape 1: [{ followed by a string-key
	if (/^\[\s*\{\s*['"]/.test(trimmed)) return "[{'key': ...} pseudo-JSON array of dicts";
	// Shape 2: { followed by a string-key on the first line and another { soon after
	// (single-object pseudo-JSON wrapping multiple constructs).
	if (/^\{\s*['"][^'"]+['"]\s*:\s*['"]/.test(trimmed)) {
		// Only flag when more than one key-value-with-string-value appears in the first 500 chars,
		// to avoid false-positive on a real JSON config file.
		const sample = trimmed.slice(0, 500);
		const kvCount = (sample.match(/['"][^'"]+['"]\s*:\s*['"]/g) || []).length;
		if (kvCount >= 3) return "{'key': 'value', ...} pseudo-JSON single object";
	}
	return null;
}

const createFile = defineTool({
	name: "create_file",
	label: "Create file",
	description:
		`Create a NEW file with the given content. Use this ONLY for files that don't exist yet — to MODIFY an existing file, always use the \`edit\` tool (it does SEARCH/REPLACE and is far more reliable). Hard limits: content must be <= ${MAX_LINES} lines, and must NOT look like serialized JSON/dict pseudo-code (real source code, not \`[{'key': 'value'}, ...]\`). For files larger than ${MAX_LINES} lines, write a minimal stub here, then grow it incrementally with \`edit\` calls; or use \`bash_exec\` with a heredoc (\`cat > path <<'EOF'\\n...content...\\nEOF\`). Returns { ok, path, bytes, lines } on success or { ok: false, error, hint } on rejection.`,
	parameters: Type.Object({
		path: Type.String({
			description:
				"File path to create. Relative paths are resolved against the agent's working directory. Parent directories are created automatically. If the file already exists, the call is rejected — use `edit` instead.",
		}),
		content: Type.String({
			description: `File contents, as a single string of raw source code. Must NOT be wrapped in JSON, dict, or array literals — write actual JS/TS/Python/etc. source. Hard limit: ${MAX_LINES} lines.`,
		}),
	}),
	async execute(_id, params, _signal, _onUpdate, ctx) {
		const inputPath = params.path;
		const content = params.content ?? "";

		const absPath = isAbsolute(inputPath) ? inputPath : resolve(ctx.cwd, inputPath);

		const lineCount = content.length === 0 ? 0 : content.split("\n").length;
		if (lineCount > MAX_LINES) {
			const payload: CreateFileError = {
				ok: false,
				error: `content has ${lineCount} lines, max is ${MAX_LINES}`,
				hint: `Write a smaller stub here (imports + empty function bodies), then use the \`edit\` tool to add the rest in pieces. For files genuinely needing >${MAX_LINES} lines in one shot, use \`bash_exec\` with: cat > "${inputPath}" <<'EOF'\\n<your content>\\nEOF`,
			};
			return {
				content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
				details: payload,
				isError: true,
			};
		}

		const pseudoShape = detectPseudoJson(content);
		if (pseudoShape) {
			const payload: CreateFileError = {
				ok: false,
				error: `content looks like ${pseudoShape}, not real source code`,
				hint: `Write the file as actual source (imports, functions, classes — not a JSON/dict literal of strings-of-code). If you need to embed complex multi-construct content, switch to \`bash_exec\` with: cat > "${inputPath}" <<'EOF'\\n<your raw source>\\nEOF — heredocs keep source as a literal multi-line block and sidestep string-escaping entirely.`,
			};
			return {
				content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
				details: payload,
				isError: true,
			};
		}

		try {
			await access(absPath, constants.F_OK);
			const payload: CreateFileError = {
				ok: false,
				error: `file already exists at ${absPath}`,
				hint: `Use the \`edit\` tool to modify existing files. If you really want to replace it, delete it first with \`bash_exec\` then call create_file again.`,
			};
			return {
				content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
				details: payload,
				isError: true,
			};
		} catch {
			// ENOENT — good, file doesn't exist yet, proceed.
		}

		try {
			await mkdir(dirname(absPath), { recursive: true });
			await writeFile(absPath, content, "utf-8");
		} catch (err) {
			const payload: CreateFileError = {
				ok: false,
				error: `write failed: ${(err as Error).message}`,
				hint: `Check that the path is writeable and parents can be created. Worktree is at ${ctx.cwd}.`,
			};
			return {
				content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
				details: payload,
				isError: true,
			};
		}

		const payload: CreateFileSuccess = {
			ok: true,
			path: absPath,
			bytes: Buffer.byteLength(content, "utf-8"),
			lines: lineCount,
		};
		return {
			content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
			details: payload,
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(createFile);
}
