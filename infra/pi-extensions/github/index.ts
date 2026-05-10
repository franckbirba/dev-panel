/**
 * GitHub extension for Pi (`@earendil-works/pi-coding-agent`).
 *
 * Replaces shell-quoted `gh` calls with structured tools so the model never
 * has to escape a French apostrophe through bash. Backed by the `gh` CLI
 * under the hood (writes title/body to temp files, calls gh with
 * `--title`/`--body-file` flags). Zero shell quoting on user-provided
 * strings.
 *
 * Why this exists: ZENO-339 canary 2026-05-09 — Qwen3-Coder-480B did the
 * actual fix (read+edit+test+commit+push+memory_write all correct), then
 * burned 24 retries on `gh pr create` because the title contained
 * apostrophes that broke `bash -c` quoting. This extension surfaces the
 * intent ("create a PR with this title and body") at a layer where shell
 * quoting can't bite.
 *
 * Tools registered:
 *   gh_pr_create({ title, body, base?, head?, draft?, reviewers? })
 *   gh_pr_view({ number_or_branch? })
 *   gh_pr_comment({ number, body })
 *   gh_pr_list({ state?, author?, label?, limit? })
 *   gh_pr_merge({ number, method? })
 *   gh_issue_create({ title, body, labels?, assignees? })
 *
 * All tools require:
 *   - `gh` CLI on PATH
 *   - GH_TOKEN or GITHUB_TOKEN in env (gh auto-uses GH_TOKEN)
 *   - cwd is inside a git repo with a github remote (gh figures out the
 *     repo from the remote — we don't pass --repo)
 *
 * Loaded via:
 *   pi --extension /home/deploy/projects/dev-panel/infra/pi-extensions/github
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------- helpers ----------

interface GhRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Run `gh <args>` in the given cwd. Captures stdout + stderr, returns exit
 * code. Aborts on signal. We never pass user-controlled strings as argv —
 * gh accepts file inputs for everything that could contain quotes/newlines
 * (--body-file, --title is fine because argv is not shell-parsed).
 */
function runGh(
	args: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<GhRunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("gh", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (c) => {
			stdout += c.toString();
		});
		child.stderr.on("data", (c) => {
			stderr += c.toString();
		});

		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			resolve({ exitCode: code ?? -1, stdout, stderr });
		});
	});
}

/**
 * Write a string to a freshly-mkstemp'd file so we can pass --body-file
 * without ever touching the shell. Caller is responsible for cleanup.
 */
function writeTempFile(prefix: string, content: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-gh-${prefix}-`));
	const path = join(dir, "content.txt");
	writeFileSync(path, content, "utf8");
	return path;
}

function cleanupTempFile(path: string) {
	try {
		// Wipe the parent dir — mkdtempSync gave us a unique one.
		rmSync(path.substring(0, path.lastIndexOf("/")), {
			recursive: true,
			force: true,
		});
	} catch {
		/* ignore */
	}
}

/** Format a successful run for the model — JSON in a text block. */
function ok(payload: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
		details: payload as Record<string, unknown>,
	};
}

/** Format an error for the model. The shape mirrors `gh`'s own error
 * surfaces so the model gets a useful redirect — exit code, stderr tail. */
function err(stage: string, exitCode: number, stderr: string, hint?: string) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(
					{
						ok: false,
						stage,
						exit_code: exitCode,
						stderr: stderr.trim().slice(-800),
						hint: hint ?? null,
					},
					null,
					2,
				),
			},
		],
		isError: true,
	};
}

// ---------- gh_pr_create ----------

const ghPrCreate = defineTool({
	name: "gh_pr_create",
	label: "GitHub PR create",
	description:
		"Create a pull request on GitHub for the current repo. Provide title and body as plain strings — the tool writes the body to a temp file and passes it to `gh pr create --body-file`, so quotes/newlines/apostrophes are safe (you never need to escape anything for a shell). Optionally specify base branch (default: main), head branch (default: current branch), draft flag, reviewers list. Returns the created PR's URL and number.",
	parameters: Type.Object({
		title: Type.String({
			description:
				"PR title. Plain text — no shell escaping needed. Conventional-commit prefix recommended.",
		}),
		body: Type.String({
			description:
				"PR body in markdown. Multi-line, can contain backticks, quotes, apostrophes — all safe.",
		}),
		base: Type.Optional(
			Type.String({ description: "Base branch (default: main)" }),
		),
		head: Type.Optional(
			Type.String({
				description: "Head branch (default: current checked-out branch)",
			}),
		),
		draft: Type.Optional(
			Type.Boolean({ description: "Open as draft (default: false)" }),
		),
		reviewers: Type.Optional(
			Type.Array(Type.String(), {
				description: "GitHub usernames to request review from",
			}),
		),
	}),
	async execute(_id, params, signal, _onUpdate, ctx) {
		const bodyFile = writeTempFile("pr-body", params.body);
		try {
			const args = ["pr", "create", "--title", params.title, "--body-file", bodyFile];
			if (params.base) args.push("--base", params.base);
			if (params.head) args.push("--head", params.head);
			if (params.draft) args.push("--draft");
			if (params.reviewers?.length) {
				args.push("--reviewer", params.reviewers.join(","));
			}
			const r = await runGh(args, ctx.cwd, signal);
			if (r.exitCode !== 0) {
				return err(
					"gh pr create",
					r.exitCode,
					r.stderr,
					"check that the branch is pushed (gh pr create needs an upstream); confirm GH_TOKEN has repo write scope",
				);
			}
			// gh prints the PR url on stdout (e.g. https://github.com/X/Y/pull/123)
			const url = r.stdout.trim();
			const numberMatch = url.match(/\/pull\/(\d+)/);
			return ok({
				ok: true,
				url,
				number: numberMatch ? Number(numberMatch[1]) : null,
			});
		} finally {
			cleanupTempFile(bodyFile);
		}
	},
});

// ---------- gh_pr_view ----------

const ghPrView = defineTool({
	name: "gh_pr_view",
	label: "GitHub PR view",
	description:
		"Fetch a PR's details (state, mergeable, checks, commits, files changed). If number_or_branch is omitted, returns the PR for the current branch (gh's default behavior).",
	parameters: Type.Object({
		number_or_branch: Type.Optional(
			Type.String({
				description:
					"PR number or branch name. Omit to use the current branch.",
			}),
		),
	}),
	async execute(_id, params, signal, _onUpdate, ctx) {
		const args = ["pr", "view", "--json", "number,state,title,body,baseRefName,headRefName,url,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,isDraft,author,createdAt,updatedAt"];
		if (params.number_or_branch) args.unshift(params.number_or_branch);
		// (gh pr view <ref> --json ...) — ref must come BEFORE flags? Let's be explicit.
		const ref = params.number_or_branch;
		const finalArgs = ref
			? ["pr", "view", ref, ...args.slice(2)]
			: args;
		const r = await runGh(finalArgs, ctx.cwd, signal);
		if (r.exitCode !== 0) {
			return err("gh pr view", r.exitCode, r.stderr);
		}
		try {
			return ok(JSON.parse(r.stdout));
		} catch {
			return ok({ raw: r.stdout });
		}
	},
});

// ---------- gh_pr_comment ----------

const ghPrComment = defineTool({
	name: "gh_pr_comment",
	label: "GitHub PR comment",
	description:
		"Post a comment on a PR. Body is passed via --body-file so no shell escaping is needed.",
	parameters: Type.Object({
		number: Type.Number({ description: "PR number" }),
		body: Type.String({ description: "Comment body in markdown" }),
	}),
	async execute(_id, params, signal, _onUpdate, ctx) {
		const bodyFile = writeTempFile("pr-comment", params.body);
		try {
			const r = await runGh(
				["pr", "comment", String(params.number), "--body-file", bodyFile],
				ctx.cwd,
				signal,
			);
			if (r.exitCode !== 0) {
				return err("gh pr comment", r.exitCode, r.stderr);
			}
			return ok({ ok: true, url: r.stdout.trim() });
		} finally {
			cleanupTempFile(bodyFile);
		}
	},
});

// ---------- gh_pr_list ----------

const ghPrList = defineTool({
	name: "gh_pr_list",
	label: "GitHub PR list",
	description: "List PRs in the current repo. Defaults to open PRs.",
	parameters: Type.Object({
		state: Type.Optional(
			Type.Union(
				[Type.Literal("open"), Type.Literal("closed"), Type.Literal("merged"), Type.Literal("all")],
				{ description: "Filter by state (default: open)" },
			),
		),
		author: Type.Optional(
			Type.String({ description: "Filter by author login (e.g., '@me')" }),
		),
		label: Type.Optional(
			Type.String({ description: "Filter by label name" }),
		),
		limit: Type.Optional(
			Type.Number({ description: "Max results (default: 30)" }),
		),
	}),
	async execute(_id, params, signal, _onUpdate, ctx) {
		const args = ["pr", "list", "--json", "number,title,state,author,createdAt,updatedAt,url,headRefName,baseRefName,isDraft"];
		if (params.state) args.push("--state", params.state);
		if (params.author) args.push("--author", params.author);
		if (params.label) args.push("--label", params.label);
		if (params.limit) args.push("--limit", String(params.limit));
		const r = await runGh(args, ctx.cwd, signal);
		if (r.exitCode !== 0) {
			return err("gh pr list", r.exitCode, r.stderr);
		}
		try {
			return ok(JSON.parse(r.stdout));
		} catch {
			return ok({ raw: r.stdout });
		}
	},
});

// ---------- gh_pr_merge ----------

const ghPrMerge = defineTool({
	name: "gh_pr_merge",
	label: "GitHub PR merge",
	description:
		"Merge a PR. Default method is 'squash'. For builders this is rarely the right tool — the merge-coordinator workflow handles merges. Surface this only if explicitly asked. Supports --match-head-commit for race-safe merges (aborts if a new push raced in) and an optional commit body that is passed via --body-file (no shell escaping).",
	parameters: Type.Object({
		number: Type.Number({ description: "PR number" }),
		method: Type.Optional(
			Type.Union(
				[Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")],
				{ description: "Merge method (default: squash)" },
			),
		),
		delete_branch: Type.Optional(
			Type.Boolean({ description: "Delete branch after merge (default: true)" }),
		),
		match_head_commit: Type.Optional(
			Type.String({
				description:
					"SHA of the head commit you observed via gh_pr_view. If the PR's head has moved since you checked, the merge aborts (gh exits non-zero) — race-safe pattern for the merge-coordinator. Omit for non-race-sensitive merges.",
			}),
		),
		body: Type.String({
			description:
				"Optional merge commit body (markdown). Passed via --body-file so quotes/newlines/apostrophes are safe. Leave empty for the default behavior (gh uses the PR title/body).",
			default: "",
		}),
	}),
	async execute(_id, params, signal, _onUpdate, ctx) {
		const method = params.method ?? "squash";
		const args = ["pr", "merge", String(params.number), `--${method}`];
		if (params.delete_branch !== false) args.push("--delete-branch");
		if (params.match_head_commit) {
			args.push("--match-head-commit", params.match_head_commit);
		}
		let bodyFile: string | null = null;
		try {
			if (params.body && params.body.length > 0) {
				bodyFile = writeTempFile("pr-merge-body", params.body);
				args.push("--body-file", bodyFile);
			}
			const r = await runGh(args, ctx.cwd, signal);
			if (r.exitCode !== 0) {
				const isHeadMoved = /head.*commit.*does not match|head ref oid|HEAD has changed/i.test(
					r.stderr,
				);
				return err(
					"gh pr merge",
					r.exitCode,
					r.stderr,
					isHeadMoved
						? "PR head moved since you observed it (race) — re-run gh_pr_view and decide whether to retry or block"
						: undefined,
				);
			}
			return ok({ ok: true, output: r.stdout.trim() });
		} finally {
			if (bodyFile) cleanupTempFile(bodyFile);
		}
	},
});

// ---------- gh_issue_create ----------

const ghIssueCreate = defineTool({
	name: "gh_issue_create",
	label: "GitHub issue create",
	description:
		"Create a GitHub issue. Body via --body-file (no shell escaping). For dev-panel projects, prefer creating a Plane work item via the plane MCP — issues are second-class.",
	parameters: Type.Object({
		title: Type.String({ description: "Issue title" }),
		body: Type.String({ description: "Issue body in markdown" }),
		labels: Type.Optional(Type.Array(Type.String())),
		assignees: Type.Optional(Type.Array(Type.String())),
	}),
	async execute(_id, params, signal, _onUpdate, ctx) {
		const bodyFile = writeTempFile("issue-body", params.body);
		try {
			const args = ["issue", "create", "--title", params.title, "--body-file", bodyFile];
			if (params.labels?.length) args.push("--label", params.labels.join(","));
			if (params.assignees?.length)
				args.push("--assignee", params.assignees.join(","));
			const r = await runGh(args, ctx.cwd, signal);
			if (r.exitCode !== 0) {
				return err("gh issue create", r.exitCode, r.stderr);
			}
			const url = r.stdout.trim();
			const numberMatch = url.match(/\/issues\/(\d+)/);
			return ok({
				ok: true,
				url,
				number: numberMatch ? Number(numberMatch[1]) : null,
			});
		} finally {
			cleanupTempFile(bodyFile);
		}
	},
});

// ---------- entry point ----------

export default function (pi: ExtensionAPI) {
	pi.registerTool(ghPrCreate);
	pi.registerTool(ghPrView);
	pi.registerTool(ghPrComment);
	pi.registerTool(ghPrList);
	pi.registerTool(ghPrMerge);
	pi.registerTool(ghIssueCreate);
}
