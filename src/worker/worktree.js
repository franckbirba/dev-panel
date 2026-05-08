// Per-job git worktree isolation for agent runs (DEVPA-144).
//
// Why: the worker spawns claude -p subprocesses that mutate the git working
// tree (checkout, commit, push). With WORKER_CONCURRENCY=3, three concurrent
// agents in the same checkout produced contaminated branches and confused
// reviewers/QA reading `git diff main...HEAD`. This module gives each job
// its own isolated worktree that is cleaned up on completion.
//
// Lifecycle:
//   const wt = await prepareWorktree(job_id, { workItem, sequenceId, baseBranch });
//   try { ...spawn agent in wt.path on wt.branch... }
//   finally { await wt.cleanup(); }
//
// Skipped for agents that don't need a working tree (pm/architect/designer
// only touch Plane/Penpot/Affine; deploy runs make, no commits;
// bootstrap/shelly_digest are pre-spawn shell handlers).

import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const NON_CODING_AGENTS = new Set([
  'pm', 'architect', 'designer',
  'deploy', 'bootstrap', 'shelly_digest', 'pr_scanner'
]);

const WORKTREES_BASE = process.env.DEVPANEL_WORKTREES
  || join(process.env.DEVPANEL_STORAGE || './storage', 'worktrees');

const WORKTREES_ENABLED =
  (process.env.DEVPANEL_WORKTREES_ENABLED ?? 'true').toLowerCase() !== 'false';

function slugify(s, max = 32) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'work';
}

// Build a stable, sortable, descriptive branch name. Examples:
//   feat/DEVPA-144-worker-worktree-isolation     (sequence available)
//   feat/wi-228066cb-worker-worktree-isolation   (UUID fallback)
//   feat/wi-github-epitec-fix-zeno-pagination    (synthetic ID like
//                                                 "github:owner/repo#42")
function deriveBranch({ sequenceId, projectIdentifier, workItemId, title }) {
  const slug = slugify(title);
  if (sequenceId && projectIdentifier) {
    return `feat/${projectIdentifier}-${sequenceId}-${slug}`;
  }
  if (workItemId) {
    // UUIDs slice cleanly to a-f0-9 + hyphen; synthetic IDs from the GitHub
    // webhook (`github:owner/repo#42`) contain `:`, `/`, `#` — all illegal
    // in git refs. `git worktree add -b` rejects them outright (observed in
    // prod: jobs 1581/1605/1607/1609 looped on "fatal: 'feat/wi-github:E-…'
    // is not a valid branch name"). Slugify the leading 12 chars only when
    // the raw slice would be unsafe, so existing UUID-based names stay byte
    // identical for idempotence with already-running instances.
    const head = workItemId.slice(0, 12);
    const safe = /^[a-z0-9-]+$/.test(head)
      ? workItemId.slice(0, 8)
      : slugify(head, 12);
    return `feat/wi-${safe}-${slug}`;
  }
  return `feat/job-${slug}`;
}

function git(args, cwd) {
  return execSync(`git ${args}`, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

// Parse `git worktree list --porcelain` into [{ path, branch }] pairs.
// Returns [] on any failure — callers treat empty as "nothing to reclaim".
function listWorktrees(repoRoot) {
  let out;
  try { out = git('worktree list --porcelain', repoRoot); }
  catch { return []; }
  const records = [];
  let cur = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur.path) records.push(cur);
      cur = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ')) {
      // branch refs come as "branch refs/heads/<name>"; strip the prefix
      const ref = line.slice('branch '.length).trim();
      cur.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
  }
  if (cur.path) records.push(cur);
  return records;
}

// Reclaim a stale worktree before we try to claim its path or branch.
// Safe under the worker's invariant: BullMQ never dispatches the same
// jobId concurrently, and this fleet runs a single worker host — so any
// worktree we conflict with is owned by a dead/finished job.
//
// Failures are non-fatal and logged; the subsequent `git worktree add`
// will surface a clearer error if reclamation didn't work.
function reclaimWorktree(wtPath, repoRoot, reason) {
  console.warn(`[worktree] reclaiming stale worktree ${wtPath} (${reason})`);
  try { git(`worktree remove --force "${wtPath}"`, repoRoot); }
  catch (err) {
    console.warn(`[worktree] reclaim remove failed: ${err.message?.slice(0, 200)}`);
    try { git('worktree prune', repoRoot); } catch { /* ignore */ }
  }
}

// Skip predicate — exposed for tests and for the worker's branch logic.
export function shouldUseWorktree(agent) {
  if (!WORKTREES_ENABLED) return false;
  if (!agent) return false;
  return !NON_CODING_AGENTS.has(agent);
}

// Returns null when worktree isolation is disabled or unsupported for this
// agent. Otherwise returns { path, branch, cleanup }. Never throws on the
// skip path — the caller can fall back to PROJECT_ROOT directly.
export async function prepareWorktree(jobId, opts = {}) {
  const {
    agent,
    workItem = {},
    sequenceId,
    projectIdentifier,
    workItemId,
    baseBranch = 'main',
    repoRoot = process.env.PROJECT_ROOT || process.cwd()
  } = opts;

  if (!shouldUseWorktree(agent)) return null;

  // Reviewer/QA may want to keep working on an existing branch rather than
  // a fresh one. Honour an explicit branch override; only auto-derive when
  // the caller didn't pin one.
  const branch = opts.branch
    || deriveBranch({ sequenceId, projectIdentifier, workItemId, title: workItem.title });

  mkdirSync(WORKTREES_BASE, { recursive: true });
  const path = join(WORKTREES_BASE, String(jobId));

  // Drop git's record of any worktree whose on-disk path no longer exists.
  // Cheap and idempotent — keeps the next list/add commands seeing a clean
  // view without us having to grep for "missing" markers.
  try { git('worktree prune', repoRoot); } catch { /* best effort */ }

  // Reclaim a stale path at our exact slot. BullMQ won't dispatch the same
  // jobId concurrently, so anything still sitting here is from a previous
  // attempt of THIS job (worker SIGTERM, OOM, restart mid-run) and is by
  // definition dead. Without this, every retry after a killed job died on
  // "worktree path already exists" and required a 9pm SSH cleanup — see
  // canary chain 2026-05-08.
  if (existsSync(path)) {
    const known = listWorktrees(repoRoot).find(w => w.path === path);
    if (known) {
      reclaimWorktree(path, repoRoot, 'same-jobId slot left behind by previous attempt');
    } else {
      // Bare directory with no git record — leftover from a partially-failed
      // `worktree add` or a manual `rm -rf .git/worktrees/<id>` without the
      // matching `rm -rf <path>`. Safe to drop.
      console.warn(`[worktree] removing orphan directory at ${path} (no git record)`);
      try { rmSync(path, { recursive: true, force: true }); } catch (err) {
        console.warn(`[worktree] orphan rm failed: ${err.message?.slice(0, 200)}`);
      }
    }
  }

  // Best-effort fetch so the new branch is based on the freshest origin.
  // Failure is non-fatal: a disconnected runner can still work off the
  // cached refs.
  try { git(`fetch origin ${baseBranch} --prune`, repoRoot); }
  catch (err) { console.warn(`[worktree] fetch failed: ${err.message}`); }

  // When the caller pinned an existing branch (reviewer/qa retreat OR
  // merge-coordinator on a PR head), make sure that branch's tip is also
  // fetched. Without this `rev-parse --verify origin/<branch>` below
  // misses fresh remotes and we'd silently create a new branch off main
  // instead of checking out the PR's actual head.
  if (opts.branch) {
    try { git(`fetch origin ${opts.branch}:refs/remotes/origin/${opts.branch} --prune`, repoRoot); }
    catch { /* branch may not exist on origin yet — checked below */ }
  }

  // Does the branch already exist locally or on origin? Reviewer/QA reuse.
  let branchExists = false;
  try {
    git(`rev-parse --verify --quiet "refs/heads/${branch}"`, repoRoot);
    branchExists = true;
  } catch { /* not local */ }
  if (!branchExists) {
    try {
      git(`rev-parse --verify --quiet "refs/remotes/origin/${branch}"`, repoRoot);
      branchExists = true;
      // Materialize a tracking local branch from the remote.
      git(`branch --track "${branch}" "origin/${branch}"`, repoRoot);
    } catch { /* not on remote either */ }
  }

  // Reclaim a stale worktree that's still attached to the branch we want.
  // Common after a SIGTERM/OOM kill — git keeps the branch pinned to the
  // dead worktree's path, and the next `worktree add` fails with
  // "'feat/wi-...' is already used by worktree at ...". Same invariant as
  // the same-slot reclaim above: single-host worker, no concurrent same-job
  // dispatch, so the holder is dead.
  const conflicting = listWorktrees(repoRoot).find(w => w.branch === branch && w.path !== path);
  if (conflicting) {
    reclaimWorktree(conflicting.path, repoRoot, `branch ${branch} pinned to dead worktree`);
  }

  // Create the worktree. New branch off baseBranch; existing branch checked out.
  if (branchExists) {
    git(`worktree add "${path}" "${branch}"`, repoRoot);
  } else {
    git(`worktree add -b "${branch}" "${path}" "origin/${baseBranch}"`, repoRoot);
  }

  return {
    path,
    branch,
    cleanup: () => cleanupWorktree(path, repoRoot)
  };
}

// Idempotent. Logs but never throws — cleanup must not break job completion.
export async function cleanupWorktree(path, repoRoot = process.env.PROJECT_ROOT || process.cwd()) {
  if (!path) return;
  try {
    git(`worktree remove --force "${path}"`, repoRoot);
  } catch (err) {
    // Common case: path already gone. `worktree prune` handles stale entries.
    console.warn(`[worktree] remove failed for ${path}: ${err.message?.slice(0, 200)}`);
    try { git('worktree prune', repoRoot); } catch { /* ignore */ }
  }
}

// Test seam — also useful for an `admin/worktree-gc` cron one day.
export const __internal = {
  deriveBranch,
  slugify,
  WORKTREES_BASE,
  NON_CODING_AGENTS,
  isEnabled: () => WORKTREES_ENABLED
};
