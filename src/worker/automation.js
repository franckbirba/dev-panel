// src/worker/automation.js
import { execSync } from 'child_process';
import { logStep, countMemoryWrites } from '../server/jobs-log.js';
import { notifyJob } from '../server/alerts.js';
import { loadWorkflows, triggerNext } from './engine.js';
import { getQueue, QUEUES, PRIORITY_MAP } from '../server/bullmq.js';

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

// publishEvent above HTTP-POSTs to the services-node SSE publish endpoint;
// worker and server are on different nodes in prod, so direct broadcast
// would not cross the boundary. emitEvent is the fire-and-forget wrapper
// the engine uses.
function emitEvent(event, data) {
  publishEvent(event, data).catch(() => {}); // SSE is best-effort
}

async function runStep(job_id, agent, step, fn) {
  const start = Date.now();
  try {
    await fn();
    await logStep({ job_id, agent, step, status: 'ok', duration_ms: Date.now() - start });
    publishEvent('job.step', { job_id, agent, step, status: 'ok' });
  } catch (err) {
    await logStep({ job_id, agent, step, status: 'error', error: err.message, duration_ms: Date.now() - start });
    publishEvent('job.step', { job_id, agent, step, status: 'error', error: err.message });
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

function createPullRequest({ branch, title, body, cwd: cwdOverride }) {
  const cwd = cwdOverride || process.env.PROJECT_ROOT || process.cwd();
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
      `gh pr create --repo franckbirba/dev-panel --base main --head ${branch} ` +
      `--title ${JSON.stringify(safeTitle)} --body ${JSON.stringify(safeBody)}`,
      { cwd, env, encoding: 'utf8' }
    ).trim();
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || '').toString();
    if (msg.includes('already exists')) {
      // Look up existing PR URL
      try {
        return execSync(
          `gh pr list --repo franckbirba/dev-panel --head ${branch} --json url --jq '.[0].url'`,
          { env, encoding: 'utf8' }
        ).trim();
      } catch { return null; }
    }
    throw new Error(`gh pr create: ${msg.slice(0, 400)}`);
  }
}

async function setPlaneState({ workItemId, stateName }) {
  const base = (process.env.PLANE_BASE_URL || '').replace(/\/$/, '');
  const slug = process.env.PLANE_WORKSPACE_SLUG;
  const key  = process.env.PLANE_API_KEY;
  const pid  = process.env.PLANE_PROJECT_ID;
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

  let prUrl = null;
  if (branch) {
    await runStep(job_id, agent, 'publish.git_push', () => pushBranch(branch, wtPath));
    await runStep(job_id, agent, 'publish.pr_create', () => {
      prUrl = createPullRequest({ branch, title, body, cwd: wtPath });
    });
  } else {
    console.warn(`[publish] no feature branch found for work_item ${workItemId}`);
  }

  await runStep(job_id, agent, 'publish.plane_state',
    () => setPlaneState({ workItemId, stateName: 'Done' }));

  // Explicit Telegram ping with the PR URL if we have one — the notifyJob
  // inside runAutomation already pinged once with the QA summary; this is
  // the "ship it" confirmation with a clickable link.
  if (prUrl) {
    await runStep(job_id, agent, 'publish.notify_pr',
      () => notifyJob({
        job_id, agent: 'publisher',
        work_item_id: workItemId,
        title,
        status: 'done',
        extra: prUrl
      }));
  }
}

// --- public entrypoint ---

export async function runAutomation({ jobData, result, startedAt }) {
  const { job_id, agent, plane, context } = jobData;
  const durationMs = Date.now() - startedAt;

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
    }));

  // Terminal publisher: if this step is a `terminal: true` transition with
  // status `done`, ship the result (push branch, open PR, mark Plane Done).
  // The engine has already updated workflow_instance state; this only runs
  // on the "happy path" and all side-effects are best-effort.
  const flow = getFlows()[jobData.workflow];
  if (flow && isTerminalDone({ flow, agent, status: result.status })) {
    await publishWorkItem({ job_id, agent, jobData, result });
  }
}
