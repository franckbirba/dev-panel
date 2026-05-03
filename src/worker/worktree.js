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
import { existsSync, mkdirSync } from 'fs';
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
function deriveBranch({ sequenceId, projectIdentifier, workItemId, title }) {
  const slug = slugify(title);
  if (sequenceId && projectIdentifier) {
    return `feat/${projectIdentifier}-${sequenceId}-${slug}`;
  }
  if (workItemId) {
    return `feat/wi-${workItemId.slice(0, 8)}-${slug}`;
  }
  return `feat/job-${slug}`;
}

function git(args, cwd) {
  return execSync(`git ${args}`, { cwd, stdio: 'pipe', encoding: 'utf8' });
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

  // Refuse to clobber an existing path. If a previous job crashed before
  // cleanup, the operator must remove it manually — silent reuse is the
  // exact contamination this module exists to prevent.
  if (existsSync(path)) {
    throw new Error(
      `worktree path already exists: ${path}. ` +
      `Run \`git worktree remove --force ${path}\` and retry.`
    );
  }

  // Best-effort fetch so the new branch is based on the freshest origin.
  // Failure is non-fatal: a disconnected runner can still work off the
  // cached refs.
  try { git(`fetch origin ${baseBranch} --prune`, repoRoot); }
  catch (err) { console.warn(`[worktree] fetch failed: ${err.message}`); }

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
