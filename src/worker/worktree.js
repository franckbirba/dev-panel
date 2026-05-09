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

// Default base used when no per-project repoRoot is supplied (legacy
// dev-panel-only dispatches). For cross-project work, we store worktrees
// UNDER the target project's repo root — see worktreesBaseFor() — so
// dev-panel and Zeno can never collide on the same on-disk path. The old
// shared base (dev-panel/storage/worktrees) caused two failures on the
// 2026-05-09 ZENO-339 canary: (a) `git worktree remove` from Zeno hit
// "not a working tree" because dev-panel's git also claimed the path,
// (b) ghost directories accumulated when `remove --force` aborted on
// "Directory not empty" (node_modules locked by a running vitest).
const FALLBACK_WORKTREES_BASE = process.env.DEVPANEL_WORKTREES
  || join(process.env.DEVPANEL_STORAGE || './storage', 'worktrees');

// Per-repo worktree base: <repoRoot>/.devpanel-worktrees. Each project owns
// its own worktree dir under its own repo, so git's admin metadata in
// `<repoRoot>/.git/worktrees/<id>` always matches the on-disk path. Add
// `.devpanel-worktrees/` to that project's .gitignore to prevent leakage
// (one-time, manual; the worker doesn't auto-add gitignore entries).
//
// Exception: when repoRoot IS the worker's own PROJECT_ROOT (dev-panel
// dispatching a DEVPA work-item to itself), keep the historical fallback
// base under <DEVPANEL_STORAGE>/worktrees/. dev-panel doesn't collide with
// itself, the layout is well-known to ops, and migrating it would require
// cleaning up live worktrees from in-flight jobs.
function worktreesBaseFor(repoRoot) {
  if (!repoRoot) return FALLBACK_WORKTREES_BASE;
  const projectRoot = process.env.PROJECT_ROOT;
  if (projectRoot && repoRoot === projectRoot) return FALLBACK_WORKTREES_BASE;
  return join(repoRoot, '.devpanel-worktrees');
}

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
// Two failure modes seen in production:
//   1. `git worktree remove --force` succeeds at clearing the admin entry
//      but fails at deleting the directory (`Directory not empty`) when
//      a child process (e.g. vitest) was holding a lock on node_modules.
//      Result: ghost directory of files with no .git linkage.
//   2. Cross-project dispatches used to share a single WORKTREES_BASE
//      under dev-panel/storage; one project's git could claim a path
//      another project's `worktree add` then refused to touch.
// Both are now defended against:
//   - Per-repo base path (worktreesBaseFor) eliminates (2).
//   - rm -rf after the git remove eliminates (1) — git's prune restores
//     the admin state so the next worktree-add starts clean.
function reclaimWorktree(wtPath, repoRoot, reason) {
  console.warn(`[worktree] reclaiming stale worktree ${wtPath} (${reason})`);
  let gitRemoveOk = false;
  try {
    git(`worktree remove --force "${wtPath}"`, repoRoot);
    gitRemoveOk = true;
  } catch (err) {
    console.warn(`[worktree] reclaim remove failed: ${err.message?.slice(0, 200)}`);
  }
  // Always force-clear the on-disk path, even if git's remove already
  // succeeded — git's success doesn't mean files were deleted (see footgun
  // above). Idempotent: rmSync force=true on a missing path is a no-op.
  if (existsSync(wtPath)) {
    try { rmSync(wtPath, { recursive: true, force: true }); }
    catch (err) {
      console.warn(`[worktree] reclaim rm -rf failed: ${err.message?.slice(0, 200)}`);
    }
  }
  // Prune to reconcile git's view with what's actually on disk. Cheap.
  if (!gitRemoveOk) {
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

  // Per-repo worktree base. Each project's worktrees live under its own
  // repo (<repoRoot>/.devpanel-worktrees/<jobId>) so we cannot collide on
  // path with another project. Pre-2026-05-09 worktrees lived in dev-panel's
  // shared storage; we fall back to that when repoRoot is missing (legacy
  // / unit-test paths) but every real dispatch carries a repoRoot now.
  const wtBase = worktreesBaseFor(repoRoot);
  mkdirSync(wtBase, { recursive: true });
  const path = join(wtBase, String(jobId));

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

  // Reclaim any stale worktree still attached to the target branch, BEFORE
  // we touch the branch itself. Common after a SIGTERM/OOM kill — git keeps
  // the branch pinned to the dead worktree's path, and `branch -D` would
  // refuse ("currently checked out at ..."). Single-host worker invariant
  // means the holder is dead; reclaim is safe.
  const conflicting = listWorktrees(repoRoot).find(w => w.branch === branch && w.path !== path);
  if (conflicting) {
    reclaimWorktree(conflicting.path, repoRoot, `branch ${branch} pinned to dead worktree`);
  }

  // Branch resolution. Two cases:
  //
  // (a) Caller pinned `opts.branch` (reviewer/qa retreat, merge-coordinator
  //     on a PR head). The branch IS the work — honour it and check it out
  //     at whatever commit it currently points to. If only on origin, track.
  //
  // (b) We derived the branch from work-item id. An existing local branch
  //     is almost always stale residue from a prior failed run. Reusing it
  //     silently checks out the OLD commit (canary 2122 on 2026-05-08: worker
  //     was at e800147 but the local `feat/wi-4360623f-...` branch from
  //     canary 2108 still pointed to 46bd339 → new worktree got built on a
  //     stale base). For derived branches, force-delete the stale local
  //     ref so the worktree-add below recreates it off origin/<base>.
  let branchExists = false;
  if (opts.branch) {
    try {
      git(`rev-parse --verify --quiet "refs/heads/${branch}"`, repoRoot);
      branchExists = true;
    } catch { /* not local */ }
    if (!branchExists) {
      try {
        git(`rev-parse --verify --quiet "refs/remotes/origin/${branch}"`, repoRoot);
        branchExists = true;
        git(`branch --track "${branch}" "origin/${branch}"`, repoRoot);
      } catch { /* not on remote either */ }
    }
  } else {
    try {
      git(`rev-parse --verify --quiet "refs/heads/${branch}"`, repoRoot);
      console.warn(`[worktree] deleting stale local branch ${branch} (re-derived for builder)`);
      try { git(`branch -D "${branch}"`, repoRoot); }
      catch (err) { console.warn(`[worktree] branch -D failed: ${err.message?.slice(0, 200)}`); }
    } catch { /* not local — nothing to clean */ }
    // branchExists stays false → take the `worktree add -b ... origin/<base>` path below.
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
//
// Two-stage cleanup, mirroring reclaimWorktree's defenses:
//   1. `git worktree remove --force` clears the admin entry. Can fail with
//      "Directory not empty" if a child process holds a lock on
//      node_modules (vitest workers, npm install background tasks).
//   2. `rm -rf <path>` forcibly clears the on-disk directory. Required
//      because git's failure leaves a ghost dir that the NEXT dispatch
//      mistakes for an orphan and the worker code path doesn't recover
//      cleanly from (canary 2026-05-09 ZENO-339 round 2).
//   3. `git worktree prune` reconciles when (1) failed.
export async function cleanupWorktree(path, repoRoot = process.env.PROJECT_ROOT || process.cwd()) {
  if (!path) return;
  let gitRemoveOk = false;
  try {
    git(`worktree remove --force "${path}"`, repoRoot);
    gitRemoveOk = true;
  } catch (err) {
    console.warn(`[worktree] remove failed for ${path}: ${err.message?.slice(0, 200)}`);
  }
  if (existsSync(path)) {
    try { rmSync(path, { recursive: true, force: true }); }
    catch (err) {
      console.warn(`[worktree] rm -rf failed for ${path}: ${err.message?.slice(0, 200)}`);
    }
  }
  if (!gitRemoveOk) {
    try { git('worktree prune', repoRoot); } catch { /* ignore */ }
  }
}

// Test seam — also useful for an `admin/worktree-gc` cron one day.
// `WORKTREES_BASE` kept as alias for the fallback base so existing tests
// (that don't pass a per-job repoRoot) keep working.
export const __internal = {
  deriveBranch,
  slugify,
  WORKTREES_BASE: FALLBACK_WORKTREES_BASE,
  FALLBACK_WORKTREES_BASE,
  worktreesBaseFor,
  NON_CODING_AGENTS,
  isEnabled: () => WORKTREES_ENABLED
};
