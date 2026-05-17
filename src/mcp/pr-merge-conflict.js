// src/mcp/pr-merge-conflict.js
//
// DEVPA-227: pr_merge_conflict({ pr_id }) — 3-way merge conflict data for a PR.
//
// Feeds the dashboard MergeArtifact UI (DEVPA-226) and fills the
// `conflict_diff` placeholder DEVPA-228's parent-context inheritance ships
// for retry-with-context flows.
//
// Resolution path:
//   1. Parse `pr_id` (accepts only `<owner>/<repo>#<number>` today — same
//      shape the github webhook + subject-graph use).
//   2. Look up `projects` row by (owner, repo) → `local_path` on disk.
//      Same authority chain the merge-coordinator dispatch uses; no GitHub
//      API quota burn.
//   3. Resolve `base_sha` from origin/<base_branch> after a shallow fetch.
//      `head_sha` comes from `gh pr view` (one cheap call — needed once
//      anyway to know base_branch + head_branch + title).
//   4. Throwaway worktree under `<local_path>/.devpanel-worktrees/pr-conflict-<id>/`
//      checked out at `base_sha`, runs `git merge --no-commit --no-ff <head_sha>`.
//      Non-zero exit ⇒ conflicts. Parse the resulting `<<<<<<<` / `=======`
//      / `>>>>>>>` markers per file. Worktree torn down in finally.
//   5. Result cached for 60s keyed on `pr_id + head_sha` so a hot dashboard
//      polling MergeArtifact doesn't spawn a worktree per refresh.
//
// Errors surface as thrown Error objects with `.code`:
//   bad_pr_id      — pr_id doesn't match the supported shape
//   project_not_found        — no projects row for owner/repo
//   project_not_linked       — projects row exists but local_path empty
//   gh_lookup_failed         — `gh pr view` failed (network, auth, gone)
//   git_failed               — git fetch/worktree/merge command failed for
//                              a reason that's NOT a conflict
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getProjectByGithubRepo } from '../server/db.js';

const PR_ID_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const CACHE_TTL_MS = 60_000;
const MAX_FILES = 200;       // hard cap — bail out on monster merges
const MAX_HUNK_LINES = 500;  // per-side cap; truncate longer hunks

const _cache = new Map(); // key = `${pr_id}:${head_sha}` → { at, payload }

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { _cache.delete(key); return null; }
  return hit.payload;
}
function cachePut(key, payload) { _cache.set(key, { at: Date.now(), payload }); }

// Test seam — let tests reset cache between runs without crossing module
// boundaries.
export function __clearCacheForTests() { _cache.clear(); }

function parsePrId(pr_id) {
  if (typeof pr_id !== 'string') return null;
  const m = pr_id.match(PR_ID_RE);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

function runGit(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  });
}

// `gh pr view` is one auth'd round-trip but it gives us head_sha, base_branch,
// head_branch, title — everything the spec asks for in `pr.*`. Cheaper than
// resolving base via origin/<branch> guesswork and avoids assuming the local
// clone is fresh enough to know about the PR's head.
function ghPrView(owner, repo, number, cwd) {
  let out;
  try {
    out = execFileSync('gh', [
      'pr', 'view', String(number),
      '--repo', `${owner}/${repo}`,
      '--json', 'number,title,headRefName,headRefOid,baseRefName,baseRefOid'
    ], { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = new Error(`gh_lookup_failed: ${e.stderr || e.message}`);
    err.code = 'gh_lookup_failed';
    throw err;
  }
  try { return JSON.parse(out); }
  catch {
    const err = new Error('gh_lookup_failed: invalid json from gh');
    err.code = 'gh_lookup_failed';
    throw err;
  }
}

// Parse a single conflicted file's contents into hunks. Returns [] if no
// markers found (file resolved itself somehow — caller filters).
//
// Marker grammar (git's default conflict-marker style):
//   <<<<<<< <label-ours>
//   ...ours lines...
//   =======
//   ...theirs lines...
//   >>>>>>> <label-theirs>
//
// Optional `|||||||` "diff3" base section is skipped if present (we don't
// emit it, the spec only asks for ours/theirs).
function parseConflictHunks(text, path) {
  const lines = text.split('\n');
  const hunks = [];
  let i = 0;
  let lineNo = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('<<<<<<<')) { i++; lineNo++; continue; }
    const start = i;
    const startLine = lineNo;
    i++; lineNo++;
    const ours = [];
    while (i < lines.length
      && !lines[i].startsWith('=======')
      && !lines[i].startsWith('|||||||')) {
      ours.push(lines[i]);
      i++; lineNo++;
    }
    // skip optional diff3 base section
    if (i < lines.length && lines[i].startsWith('|||||||')) {
      i++; lineNo++;
      while (i < lines.length && !lines[i].startsWith('=======')) { i++; lineNo++; }
    }
    if (i >= lines.length || !lines[i].startsWith('=======')) break;
    i++; lineNo++; // skip =======
    const theirs = [];
    while (i < lines.length && !lines[i].startsWith('>>>>>>>')) {
      theirs.push(lines[i]);
      i++; lineNo++;
    }
    if (i >= lines.length) break;
    i++; lineNo++; // skip >>>>>>>
    const endLine = lineNo;

    // 3 lines of context on each side — clamp to file bounds.
    const contextBefore = lines.slice(Math.max(0, startLine - 3), startLine);
    const contextAfter = lines.slice(endLine, Math.min(lines.length, endLine + 3));

    const truncatedOurs = ours.length > MAX_HUNK_LINES;
    const truncatedTheirs = theirs.length > MAX_HUNK_LINES;
    const oursOut = truncatedOurs ? ours.slice(0, MAX_HUNK_LINES) : ours;
    const theirsOut = truncatedTheirs ? theirs.slice(0, MAX_HUNK_LINES) : theirs;

    // Stable id so the UI can correlate resolve-state across refresh.
    // Includes path + start line + content fingerprint — small enough that
    // a hash collision inside one file is implausible.
    const id = createHash('sha1')
      .update(path)
      .update(':')
      .update(String(startLine))
      .update(':')
      .update(oursOut.join('\n'))
      .update('||')
      .update(theirsOut.join('\n'))
      .digest('hex')
      .slice(0, 16);

    hunks.push({
      id,
      ours_range: [startLine + 1, startLine + ours.length],
      theirs_range: [startLine + 1, startLine + theirs.length],
      ours: oursOut,
      theirs: theirsOut,
      context_before: contextBefore,
      context_after: contextAfter,
      ...(truncatedOurs || truncatedTheirs
        ? { truncated: { ours: truncatedOurs, theirs: truncatedTheirs } }
        : {})
    });
    // start incremented inside loop; continue scanning from current i
    void start;
  }
  return hunks;
}

/**
 * Resolve `pr_id` to a 3-way merge conflict snapshot.
 *
 * @param {Object} args
 * @param {string} args.pr_id — `<owner>/<repo>#<number>`
 * @returns {Promise<{pr, conflicts, generated_at}>}
 */
export async function prMergeConflict({ pr_id }) {
  const parsed = parsePrId(pr_id);
  if (!parsed) {
    const err = new Error(`bad_pr_id: expected <owner>/<repo>#<number>, got ${pr_id}`);
    err.code = 'bad_pr_id';
    throw err;
  }
  const { owner, repo, number } = parsed;

  const project = getProjectByGithubRepo(owner, repo);
  if (!project) {
    const err = new Error(`project_not_found: no projects row for ${owner}/${repo}`);
    err.code = 'project_not_found';
    throw err;
  }
  if (!project.local_path) {
    const err = new Error(`project_not_linked: projects row for ${owner}/${repo} has no local_path`);
    err.code = 'project_not_linked';
    throw err;
  }
  const repoRoot = project.local_path;

  const pr = ghPrView(owner, repo, number, repoRoot);
  const cacheKey = `${pr_id}:${pr.headRefOid}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Per-repo throwaway worktree base — same convention as the worker
  // (`<repoRoot>/.devpanel-worktrees/<id>`). Spec calls for cleanup on
  // success AND error, hence the try/finally.
  const wtBase = join(repoRoot, '.devpanel-worktrees');
  mkdirSync(wtBase, { recursive: true });
  const wtId = `pr-conflict-${number}-${pr.headRefOid.slice(0, 7)}-${Date.now()}`;
  const wtPath = join(wtBase, wtId);

  let conflicts = [];
  try {
    // Fetch both refs so we have local objects for the merge attempt. The
    // local clone is usually up-to-date but a fresh PR just opened won't
    // be — single shallow-ish fetch is cheap.
    try {
      runGit(['fetch', 'origin', pr.baseRefName, pr.headRefName], { cwd: repoRoot });
    } catch (e) {
      // Some PRs come from forks — `git fetch origin <head>` fails. Pull
      // by SHA from refs/pull/<n>/head as a fallback (GitHub mirrors it).
      try {
        runGit(['fetch', 'origin', pr.baseRefName, `refs/pull/${number}/head`], { cwd: repoRoot });
      } catch (e2) {
        const err = new Error(`git_failed: fetch refs: ${(e2.stderr || e2.message).trim()}`);
        err.code = 'git_failed';
        throw err;
      }
    }

    try {
      runGit(['worktree', 'add', '--detach', wtPath, pr.baseRefOid], { cwd: repoRoot });
    } catch (e) {
      const err = new Error(`git_failed: worktree add: ${(e.stderr || e.message).trim()}`);
      err.code = 'git_failed';
      throw err;
    }

    let mergeFailed = false;
    try {
      runGit(['merge', '--no-commit', '--no-ff', pr.headRefOid], { cwd: wtPath });
    } catch (e) {
      // Non-zero exit can mean conflict OR a real failure. Conflict is the
      // expected case — confirm via `git ls-files --unmerged`.
      mergeFailed = true;
      void e;
    }

    let unmerged = '';
    try {
      unmerged = runGit(['ls-files', '--unmerged'], { cwd: wtPath });
    } catch {
      // ls-files --unmerged failing is unusual; treat as no conflicts.
      unmerged = '';
    }
    const conflictedPaths = new Set();
    for (const line of unmerged.split('\n')) {
      if (!line.trim()) continue;
      // Each line: `<mode> <sha> <stage>\t<path>`
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      conflictedPaths.add(line.slice(tab + 1));
    }

    if (conflictedPaths.size === 0 && mergeFailed) {
      // Merge errored for a non-conflict reason (untracked clobber, hook,
      // etc.). Surface as git_failed so the caller doesn't render a fake
      // "clean merge" UI.
      const err = new Error('git_failed: merge errored without producing conflict markers');
      err.code = 'git_failed';
      throw err;
    }

    if (conflictedPaths.size > MAX_FILES) {
      const err = new Error(`git_failed: ${conflictedPaths.size} conflicted files exceeds cap of ${MAX_FILES}`);
      err.code = 'git_failed';
      throw err;
    }

    for (const path of conflictedPaths) {
      const abs = join(wtPath, path);
      let body;
      try {
        if (!existsSync(abs)) continue;
        const stat = statSync(abs);
        if (!stat.isFile()) continue;
        body = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const hunks = parseConflictHunks(body, path);
      if (hunks.length) conflicts.push({ path, hunks });
    }
  } finally {
    // Worktree removal is independent of git state — `git worktree remove
    // --force` then rm -rf the dir if git still tracks it. Best-effort:
    // we never want cleanup failure to mask the merge result.
    try { runGit(['worktree', 'remove', '--force', wtPath], { cwd: repoRoot }); }
    catch { /* fall through to fs rm */ }
    try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const payload = {
    pr: {
      number: pr.number,
      title: pr.title,
      repo: `${owner}/${repo}`,
      base_branch: pr.baseRefName,
      head_branch: pr.headRefName,
      head_sha: pr.headRefOid,
      base_sha: pr.baseRefOid
    },
    conflicts,
    generated_at: new Date().toISOString()
  };
  cachePut(cacheKey, payload);
  return payload;
}
