// src/worker/automation.js
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
    logStep({ job_id, agent, step, status: 'ok', duration_ms: Date.now() - start });
    publishEvent('job.step', { job_id, agent, step, status: 'ok' });
  } catch (err) {
    logStep({ job_id, agent, step, status: 'error', error: err.message, duration_ms: Date.now() - start });
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
  const actual = countMemoryWrites(job_id);
  const claimed = result.memory_writes_count ?? 0;
  if (actual !== claimed) {
    throw new Error(`memory_writes_count mismatch: claimed=${claimed}, actual=${actual}`);
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
}
