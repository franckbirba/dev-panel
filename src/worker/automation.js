// src/worker/automation.js
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { logStep, countMemoryWrites } from '../server/jobs-log.js';
import { notifyJob } from '../server/alerts.js';
import { loadWorkflows, triggerNext } from './engine.js';
import { getQueue, QUEUES, PRIORITY_MAP } from '../server/bullmq.js';

// DEVPA-145: same MODE_FILE convention as src/worker/index.js — Shelly's
// autonomous/collaborative toggle drives whether we auto-merge a PR.
const MODE_FILE = process.env.MODE_FILE || join(process.env.HOME || '/home/deploy', '.shelly-mode.json');

function getShellyMode() {
  try {
    if (existsSync(MODE_FILE)) {
      return JSON.parse(readFileSync(MODE_FILE, 'utf8')).mode || 'collaborative';
    }
  } catch { /* ignore — fall through to safe default */ }
  return 'collaborative';
}

const WORKER_EVENTS_URL = process.env.WORKER_EVENTS_URL || 'http://localhost:3030/api/admin/events/publish';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

async function publishEvent(event, data) {
  if (!ADMIN_API_KEY) return;
  try {
    await fetch(WORKER_EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_API_KEY },
      body: JSON.stringify({ event, data })
    });
  } catch (err) {
    console.error('[automation] publishEvent failed:', err.message);
  }
}

// Flows are loaded once per worker process; editing any YAML under
// src/worker/workflows/ requires a worker restart to take effect.
let _flows = null;
function getFlows() {
  if (!_flows) _flows = loadWorkflows();
  return _flows;
}

// Replaceable for tests
let _enqueue = async (payload) => {
  const queue = getQueue(QUEUES.agents);
  const prio = PRIORITY_MAP[payload.priority || 'p2'] || 10;
  const name = `${payload.agent}:${payload.plane?.work_item_id || 'adhoc'}`;
  return queue.add(name, payload, { priority: prio });
};

export function __setEnqueueForTests(fn) { _enqueue = fn; }

// Test seam — DEVPA-145 auto-merge code path.
export const __testables = { autoMergePullRequest: (...a) => autoMergePullRequest(...a),
                              getShellyMode };

// publishEvent above HTTP-POSTs to the services-node SSE publish endpoint;
// worker and server are on different nodes in prod, so direct broadcast
// would not cross the boundary. emitEvent is the fire-and-forget wrapper
// the engine uses.
function emitEvent(event, data) {
  publishEvent(event, data).catch(() => {}); // SSE is best-effort
}

async function runStep(job_id, agent, step, fn, { critical = false } = {}) {
  const start = Date.now();
  try {
    await fn();
    await logStep({ job_id, agent, step, status: 'ok', duration_ms: Date.now() - start });
    publishEvent('job.step', { job_id, agent, step, status: 'ok' });
  } catch (err) {
    await logStep({ job_id, agent, step, status: 'error', error: err.message, duration_ms: Date.now() - start });
    publishEvent('job.step', { job_id, agent, step, status: 'error', error: err.message });
    // Side-effects (Plane PATCH, GH sync, Telegram notify) are best-effort
    // and must not block the workflow. But the workflow transition itself is
    // load-bearing — silently swallowing it leaves the instance stuck in
    // `running` with no follow-up agent enqueued (DEVPA-174).
    if (critical) throw err;
  }
}

// --- side-effect helpers (no-ops when integrations are not configured) ---

async function updatePlane({ plane, status }) {
  if (!plane?.work_item_id || !process.env.PLANE_API_TOKEN) return;
  const base = process.env.PLANE_BASE_URL;
  const slug = process.env.PLANE_WORKSPACE_SLUG;
  if (!base || !slug || !plane.project_id) return;
  const url = `${base}/api/v1/workspaces/${slug}/projects/${plane.project_id}/issues/${plane.work_item_id}/`;
  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.PLANE_API_TOKEN },
    body: JSON.stringify({ state: { name: status } })
  });
}

async function syncGithubIssue({ agent, result, context }) {
  if (!process.env.GITHUB_TOKEN) return;
  if (agent === 'reviewer' && result.status === 'done' && context?.github_issue_number) {
    const owner = process.env.GITHUB_OWNER;
    const repo  = process.env.GITHUB_REPO;
    if (!owner || !repo) return;
    const num = context.github_issue_number;
    await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${num}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `Merged: ${result.artifacts?.pr_url || '(no PR url)'}` })
    });
    await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${num}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'closed' })
    });
  }
}

async function updateDevpanelTicket({ context, status }) {
  if (!context?.devpanel_ticket_id) return;
  const { updateTicket } = await import('../server/db.js');
  const mapping = { done: 'published', blocked: 'pending', failed: 'rejected' };
  const newStatus = mapping[status] || 'pending';
  try { updateTicket(context.devpanel_ticket_id, { status: newStatus }); }
  catch (e) { console.error('[automation] updateDevpanelTicket failed:', e.message); }
}

async function verifyMemoryWrites({ job_id, result }) {
  const actual = await countMemoryWrites(job_id);
  const claimed = result.memory_writes_count ?? 0;
  if (actual !== claimed) {
    throw new Error(`memory_writes_count mismatch: claimed=${claimed}, actual=${actual}`);
  }
}

// Worker-side commit authority. The model is treated as a pure file-mutation
// engine — its job is to edit the worktree and report status. Commit discipline
// (staging, committing, verifying a diff exists vs origin) is the WORKER's job.
//
// Why this lives here and not in the prompt: prompting Qwen3 to "remember to
// `git commit`" failed (canary 2108, 2026-05-08 — model wrote 12 untracked
// files and claimed status=done). Adding a structural gate via MOIM persistent
// instructions worked (canary 2129) but burns prompt budget every turn and
// leaks orchestration concerns into the model. The structurally-pure shape:
// model never hears about commit discipline, worker commits on its behalf
// from `artifacts.files_modified[]` ∪ `artifacts.files_created[]` ∪ whatever
// `git status --porcelain` shows. If after that there's still no diff, it
// truly didn't do the work — downgrade to blocked.
//
// Mutates `result` in place. Idempotent: only fires when status=done AND a
// worktree was used (skips non-coding agents). Returns a small report for
// logging.
function verifyAndCommit({ result, jobData }) {
  if (!result || result.status !== 'done') return { changed: false };

  const worktreePath = jobData.context?.worktree_path;
  const branch = jobData.context?.branch;
  if (!worktreePath || !branch) return { changed: false };

  // Worktree may have been cleaned up between spawn close and verifier run
  // (canary 2129, 2026-05-08). Treat as "can't verify, can't commit" — leave
  // the result alone. The `existsSync` shortcircuit must come BEFORE any
  // execSync since Node's chdir-then-execve fails with spawnSync ENOENT
  // before our try/catch runs.
  if (!existsSync(worktreePath)) {
    console.warn(`[verifier] worktree gone, skipping: ${worktreePath}`);
    return { changed: false, error: 'worktree_gone' };
  }

  const baseBranch = jobData.context?.default_branch || 'main';
  const job_id = jobData.job_id;

  function hasDiffVsOrigin() {
    try {
      execSync(`git diff --quiet "origin/${baseBranch}"...HEAD`,
               { cwd: worktreePath, stdio: 'pipe' });
      return { has: false };
    } catch (err) {
      if (err.status === 1) {
        let detail = '';
        try {
          detail = execSync(`git diff --stat "origin/${baseBranch}"...HEAD`,
                            { cwd: worktreePath, stdio: 'pipe', encoding: 'utf8' })
                   .trim().split('\n').slice(-1)[0] || '';
        } catch { /* best effort */ }
        return { has: true, detail };
      }
      return { has: false, error: err.message };
    }
  }

  // 1. Already have a real diff? Model may have committed properly. Accept.
  let diff = hasDiffVsOrigin();
  if (diff.error) {
    console.warn(`[verifier] git diff errored (skip): ${diff.error?.slice(0, 200)}`);
    return { changed: false, error: diff.error };
  }
  if (diff.has) {
    console.log(`[verifier] diff confirmed for job ${job_id}: ${diff.detail}`);
    return { changed: false, hasDiff: true };
  }

  // 2. No diff. Try to commit on the model's behalf. This is the structural
  // shift: the worker is the commit authority. Stage anything the model
  // claimed it touched, fall back to whatever git sees as dirty.
  const claimed = [
    ...(Array.isArray(result.artifacts?.files_modified) ? result.artifacts.files_modified : []),
    ...(Array.isArray(result.artifacts?.files_created)  ? result.artifacts.files_created  : []),
  ].filter(p => typeof p === 'string' && p.length > 0);

  let dirty = '';
  try {
    dirty = execSync('git status --porcelain',
                     { cwd: worktreePath, stdio: 'pipe', encoding: 'utf8' }).trim();
  } catch { /* best effort */ }

  // Stage exactly the files the model claimed it touched. Never `git add .`
  // / `git add -A` — a worker-managed worktree may carry residue from a
  // half-failed prior run, IDE detritus, OS files; sweeping all dirty paths
  // would commit cruft as if it were the work item's diff. If the model
  // returned an empty manifest, we DO NOT guess — we let the downgrade-to-
  // blocked path fire. Untracked files that aren't in the manifest are a
  // signal the model lied about scope; replan is the right answer.
  let staged = false;
  let stageError = null;
  if (claimed.length > 0) {
    try {
      // Stage in batches; long file lists can blow argv. 100/batch is safe.
      for (let i = 0; i < claimed.length; i += 100) {
        const batch = claimed.slice(i, i + 100).map(p => `"${p.replace(/"/g, '\\"')}"`).join(' ');
        execSync(`git add -- ${batch}`, { cwd: worktreePath, stdio: 'pipe' });
      }
      staged = true;
    } catch (err) {
      stageError = err.message?.slice(0, 200);
      console.warn(`[verifier] git add (claimed) failed: ${stageError}`);
    }
  }

  if (staged) {
    // Commit with the model's summary. If the staged diff is empty (e.g.,
    // model claimed files that match HEAD already), commit will fail —
    // that's fine, we'll just fall through to the no-diff downgrade.
    const subject = (result.summary || `agent ${jobData.agent} work`).split('\n')[0].slice(0, 72);
    const body = result.summary && result.summary.length > 72
      ? `\n\n${result.summary}`
      : '';
    const message = `${subject}${body}\n\nCo-authored-by: ${jobData.agent} <agent@devpanl.dev>`;
    try {
      // Use stdin to avoid quoting hell on multi-line summaries.
      execSync('git commit -F -', {
        cwd: worktreePath,
        stdio: ['pipe', 'pipe', 'pipe'],
        input: message,
      });
      console.log(`[verifier] auto-committed for job ${job_id}: ${subject}`);
    } catch (err) {
      // Common: "nothing to commit" because everything staged was identical
      // to HEAD. Don't treat as fatal; fall through to the diff re-check.
      console.warn(`[verifier] auto-commit failed (proceeding): ${err.message?.slice(0, 200)}`);
    }
  }

  // 3. Re-check diff after our commit attempt.
  diff = hasDiffVsOrigin();
  if (diff.has) {
    console.log(`[verifier] diff confirmed AFTER auto-commit for job ${job_id}: ${diff.detail}`);
    return { changed: false, hasDiff: true, autoCommitted: staged };
  }

  // 4. Still no diff. Real downgrade.
  const claimedSummary = result.summary || '(no summary provided)';
  const dirtyNote = dirty
    ? ` Dirty files at verify time:\n${dirty.split('\n').slice(0, 20).join('\n')}`
    : ' Worktree was clean — model produced no files at all.';
  const stageNote = stageError ? ` Stage error: ${stageError}.` : '';

  result.status = 'blocked';
  result.summary = `[verifier] model claimed status=done but produced no diff against origin/${baseBranch} even after worker auto-commit attempt. Original summary: ${claimedSummary}.${dirtyNote}${stageNote}`;
  result.blockers = result.blockers || [];
  result.blockers.push({
    kind: 'no_diff',
    detail: `worktree ${worktreePath} has no diff vs origin/${baseBranch} after auto-commit`,
    files_claimed: claimed.length,
    dirty_files: dirty ? dirty.split('\n').length : 0,
  });

  console.warn(`[verifier] downgraded job ${job_id} to blocked: no diff after auto-commit.${dirtyNote}`);
  return { changed: true, downgradedTo: 'blocked' };
}

// ---------------------------------------------------------------------------
// Terminal publisher — closes the loop on successful work-item workflows.
// When qa.done triggers `terminal: true`, this fires: locate the builder's
// feature branch, push it, open a PR, and move the Plane work item to the
// "Done" state so the backlog puller stops re-dispatching it. Each side
// effect is independent — a push failure doesn't block PR creation, etc.
// ---------------------------------------------------------------------------

function isTerminalDone({ flow, agent, status }) {
  const step = flow?.steps?.find(s => s.agent === agent);
  return Boolean(step?.on?.[status]?.terminal) && status === 'done';
}

// Find the feature branch whose name contains the first 8 chars of the
// work_item_id (builder convention: feat/<uuid-short>-<slug>). Falls back to
// any branch referencing the full work_item_id in its name.
function findWorkItemBranch(workItemId, cwdOverride) {
  if (!workItemId) return null;
  const cwd = cwdOverride || process.env.PROJECT_ROOT || process.cwd();
  const shortId = workItemId.slice(0, 8);
  try {
    const out = execSync(
      `git -C "${cwd}" for-each-ref --format='%(refname:short)' refs/heads/`,
      { encoding: 'utf8' }
    );
    const branches = out.split('\n').map(s => s.trim()).filter(Boolean);
    return (
      branches.find(b => b.includes(shortId)) ||
      branches.find(b => b.includes(workItemId)) ||
      null
    );
  } catch {
    return null;
  }
}

function pushBranch(branch, cwdOverride) {
  const cwd = cwdOverride || process.env.PROJECT_ROOT || process.cwd();
  // --force-with-lease keeps us safe if the remote has moved (e.g. replan
  // round overwrites a prior push), without the danger of plain --force.
  execSync(`git -C "${cwd}" push --force-with-lease origin ${branch}`, { stdio: 'pipe' });
}

function createPullRequest({ branch, title, body, repo, baseBranch = 'main', cwd: cwdOverride }) {
  const cwd = cwdOverride || process.env.PROJECT_ROOT || process.cwd();
  // Multi-repo: caller must pass `repo` ("owner/name"). Legacy single-repo
  // dispatches (no projects row, e.g. ad-hoc Telegram→Shelly) fall back to
  // dev-panel. ZENO/EDMS work items now carry context.github_repo set by
  // enqueueWorkflowStart from the projects row.
  const targetRepo = repo || 'franckbirba/dev-panel';
  const safeTitle = String(title || '').slice(0, 100).replace(/\n/g, ' ');
  const safeBody = String(body || '');
  // gh CLI reads GH_TOKEN. We mirror GITHUB_TOKEN into it for this call.
  const env = { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN || '' };
  // If a PR for this branch already exists, `gh pr create` errors — tolerate
  // that since the goal is idempotent "ensure PR exists".
  try {
    execSync(
      `git -C "${cwd}" fetch origin ${branch} 2>/dev/null || true`,
      { env }
    );
    return execSync(
      `gh pr create --repo ${targetRepo} --base ${baseBranch} --head ${branch} ` +
      `--title ${JSON.stringify(safeTitle)} --body ${JSON.stringify(safeBody)}`,
      { cwd, env, encoding: 'utf8' }
    ).trim();
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || '').toString();
    if (msg.includes('already exists')) {
      // Look up existing PR URL
      try {
        return execSync(
          `gh pr list --repo ${targetRepo} --head ${branch} --json url --jq '.[0].url'`,
          { env, encoding: 'utf8' }
        ).trim();
      } catch { return null; }
    }
    throw new Error(`gh pr create: ${msg.slice(0, 400)}`);
  }
}

// DEVPA-145: enable auto-merge on the PR. `gh pr merge --auto` queues the
// merge and waits until all required checks pass + branch protection allows
// it. Returns true if the merge was queued, false if the PR was already
// merged or auto-merge was rejected (e.g., admin override needed).
function autoMergePullRequest({ prUrl, cwd: cwdOverride }) {
  if (!prUrl) return { ok: false, reason: 'no PR URL' };
  const cwd = cwdOverride || process.env.PROJECT_ROOT || process.cwd();
  const env = { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN || '' };
  try {
    // --auto = wait for required checks and merge automatically.
    // --squash = matches existing repo convention (one commit per work-item).
    // --delete-branch = clean up after; the worktree is already gone by the
    //   time GitHub fires the merge, so this matters only for the remote.
    const out = execSync(
      `gh pr merge ${JSON.stringify(prUrl)} --squash --auto --delete-branch`,
      { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { ok: true, output: (out || '').trim() };
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || '').toString();
    // Already merged is a success, not a failure — idempotent.
    if (/already merged|already closed/i.test(msg)) {
      return { ok: true, already_merged: true };
    }
    // Auto-merge requires the feature to be enabled in repo settings + a
    // protected base branch. If GitHub refuses, surface the reason but don't
    // crash the workflow — the PR is still open for manual merge.
    return { ok: false, reason: msg.slice(0, 400) };
  }
}

async function setPlaneState({ workItemId, stateName, projectId }) {
  const base = (process.env.PLANE_BASE_URL || '').replace(/\/$/, '');
  const slug = process.env.PLANE_WORKSPACE_SLUG;
  const key  = process.env.PLANE_API_KEY;
  // Multi-tenant: prefer the per-job project_id (set by enqueueWorkflowStart
  // from the Plane work item's project field). Fall back to PLANE_PROJECT_ID
  // env only for legacy single-tenant ad-hoc dispatches.
  const pid  = projectId || process.env.PLANE_PROJECT_ID;
  if (!base || !slug || !key || !pid || !workItemId) return null;

  const statesRes = await fetch(
    `${base}/api/v1/workspaces/${slug}/projects/${pid}/states/`,
    { headers: { 'X-API-Key': key } }
  );
  if (!statesRes.ok) throw new Error(`plane states ${statesRes.status}`);
  const statesJson = await statesRes.json();
  const list = statesJson.results || statesJson;
  const target = list.find(s => s.name === stateName);
  if (!target) throw new Error(`Plane state "${stateName}" not found`);

  const patchRes = await fetch(
    `${base}/api/v1/workspaces/${slug}/projects/${pid}/issues/${workItemId}/`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ state: target.id })
    }
  );
  if (!patchRes.ok) throw new Error(`plane patch ${patchRes.status}`);
  return target.id;
}

async function publishWorkItem({ job_id, agent, jobData, result }) {
  const workItemId = jobData.plane?.work_item_id;
  if (!workItemId) return;

  // When the worker ran in a per-job worktree (DEVPA-144), every git
  // operation must use that path. Otherwise the push happens from the
  // wrong checkout and the branch the agent actually created isn't visible.
  const wtPath = jobData.context?.worktree_path;
  const branch = jobData.context?.branch || findWorkItemBranch(workItemId, wtPath);
  const summary = result.summary || `Auto work item ${workItemId.slice(0, 8)}`;
  const title = (jobData.work_item?.title || summary).slice(0, 100);
  const body =
    `Autonomous agent pipeline completed (workflow: ${jobData.workflow}).\n\n` +
    `Work item: \`${workItemId}\`\n\n### Summary\n${summary}\n\n` +
    `_Generated by the DevPanel agent team._`;

  // Multi-repo: enqueueWorkflowStart sets context.github_repo + context.default_branch
  // from the projects row; ad-hoc legacy dispatches leave them undefined and
  // createPullRequest falls back to franckbirba/dev-panel.
  const repo = jobData.context?.github_repo;
  const baseBranch = jobData.context?.default_branch || 'main';

  let prUrl = null;
  let mergeOutcome = null;
  if (branch) {
    await runStep(job_id, agent, 'publish.git_push', () => pushBranch(branch, wtPath));
    await runStep(job_id, agent, 'publish.pr_create', () => {
      prUrl = createPullRequest({ branch, title, body, repo, baseBranch, cwd: wtPath });
    });

    // DEVPA-145: in autonomous mode, queue the PR for auto-merge. GitHub
    // waits for required checks (CI, branch protection) before flipping it.
    // In collaborative mode, Franck merges by hand — same as before.
    if (prUrl && getShellyMode() === 'autonomous') {
      await runStep(job_id, agent, 'publish.pr_merge', () => {
        mergeOutcome = autoMergePullRequest({ prUrl, cwd: wtPath });
        if (!mergeOutcome.ok) {
          // Surface the reason via runStep error so it lands in jobs_log.
          throw new Error(`auto-merge skipped: ${mergeOutcome.reason}`);
        }
      });
    }
  } else {
    console.warn(`[publish] no feature branch found for work_item ${workItemId}`);
  }

  await runStep(job_id, agent, 'publish.plane_state',
    () => setPlaneState({
      workItemId, stateName: 'Done',
      projectId: jobData.plane?.project_id
    }));

  // Explicit Telegram ping with the PR URL if we have one — the notifyJob
  // inside runAutomation already pinged once with the QA summary; this is
  // the "ship it" confirmation with a clickable link.
  if (prUrl) {
    const mergeNote = mergeOutcome?.ok
      ? (mergeOutcome.already_merged ? ' (already merged)' : ' (auto-merge queued)')
      : '';
    await runStep(job_id, agent, 'publish.notify_pr',
      () => notifyJob({
        job_id, agent: 'publisher',
        work_item_id: workItemId,
        title,
        status: 'done',
        extra: prUrl + mergeNote
      }));
  }
}

// --- public entrypoint ---

export async function runAutomation({ jobData, result, startedAt }) {
  const { job_id, agent, plane, context } = jobData;
  const durationMs = Date.now() - startedAt;

  // Worker is the commit authority — it stages and commits the model's work
  // from artifacts.files_modified[] before any notifications fire. If the
  // model truly produced nothing, downgrades status=done → blocked. Mutates
  // `result` in place. The rest of this function (Plane/Shelly/engine
  // routing) then sees the corrected status.
  verifyAndCommit({ result, jobData });

  publishEvent('job.finished', { job_id, agent, status: result.status, summary: result.summary });

  await runStep(job_id, agent, 'plane.update_work_item',
    () => updatePlane({ plane, status: result.status }));

  await runStep(job_id, agent, 'github.issue_sync',
    () => syncGithubIssue({ agent, result, context }));

  await runStep(job_id, agent, 'devpanel.update_ticket',
    () => updateDevpanelTicket({ context, status: result.status }));

  await runStep(job_id, agent, 'shelly.notify',
    () => notifyJob({
      job_id, agent,
      work_item_id: plane?.work_item_id,
      title: jobData.work_item?.title,
      status: result.status,
      duration_ms: durationMs,
      extra: result.artifacts?.commits?.length ? `${result.artifacts.commits.length} commits` : null,
      next_agent: result.handoff?.next_agent
    }));

  await runStep(job_id, agent, 'memory.verify_writes',
    () => verifyMemoryWrites({ job_id, result }));

  await runStep(job_id, agent, 'workflow.trigger_next',
    () => triggerNext({
      jobData, result,
      flows: getFlows(),
      enqueue: _enqueue,
      emit: emitEvent
    }),
    { critical: true });

  // Terminal publisher: if this step is a `terminal: true` transition with
  // status `done`, ship the result (push branch, open PR, mark Plane Done).
  // The engine has already updated workflow_instance state; this only runs
  // on the "happy path" and all side-effects are best-effort.
  const flow = getFlows()[jobData.workflow];
  if (flow && isTerminalDone({ flow, agent, status: result.status })) {
    await publishWorkItem({ job_id, agent, jobData, result });
  }
}
