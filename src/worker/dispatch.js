// src/worker/dispatch.js
import { loadWorkflows } from './engine.js';
import { createInstance, updateInstance } from '../server/workflow-instances.js';
import { getQueue, QUEUES, PRIORITY_MAP } from '../server/bullmq.js';

const WORKER_EVENTS_URL = process.env.WORKER_EVENTS_URL
  || 'http://localhost:3030/api/admin/events/publish';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

async function publishEvent(event, data) {
  if (!ADMIN_API_KEY) return;
  try {
    await fetch(WORKER_EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_API_KEY },
      body: JSON.stringify({ event, data })
    });
  } catch { /* SSE is best-effort */ }
}

let _flows = null;
function getFlows() {
  if (!_flows) _flows = loadWorkflows();
  return _flows;
}

let _enqueue = async (payload, opts = {}) => {
  const queue = getQueue(QUEUES.agents);
  const prio = PRIORITY_MAP[payload.priority || 'p2'] || 10;
  const name = `${payload.agent}:${payload.plane?.work_item_id || 'adhoc'}`;
  return queue.add(name, payload, { priority: prio, ...opts });
};
export function __setEnqueueForTests(fn) { _enqueue = fn; }

/**
 * Start a workflow on a work-item. Atomic: creates the instance row first,
 * then enqueues the first step. The unique partial index enforces one active
 * instance per (work_item_id, workflow_name).
 */
export async function enqueueWorkflowStart({
  workflow, plane, work_item = {}, context = {}, scheduled_for = null
}) {
  const flows = getFlows();
  const flow = flows[workflow];
  if (!flow) return { ok: false, error: `unknown workflow: ${workflow}` };
  if (!plane?.work_item_id) return { ok: false, error: 'missing plane.work_item_id' };
  const firstAgent = flow.steps[0].agent;

  let instance_id;
  try {
    instance_id = createInstance({
      work_item_id: plane.work_item_id,
      workflow_name: workflow,
      current_step: firstAgent,
      module_id: plane.module_id || null,
      cycle_id: plane.cycle_id || null
    });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { ok: false, error: 'already_running' };
    }
    throw e;
  }

  const opts = scheduled_for ? { delay: Math.max(0, scheduled_for - Date.now()) } : {};
  let job;
  try {
    job = await _enqueue({
      agent: firstAgent,
      workflow,
      workflow_instance_id: instance_id,
      workflow_revision: 1,
      plane,
      work_item,
      context
    }, opts);
  } catch (err) {
    // Rollback: mark this instance failed so a retry can land cleanly
    // (the unique partial index excludes 'failed' from the active set).
    try {
      updateInstance(
        { work_item_id: plane.work_item_id, workflow_name: workflow },
        { status: 'failed' }
      );
    } catch { /* best-effort rollback */ }
    return { ok: false, error: `enqueue_failed: ${err.message}` };
  }

  publishEvent('workflow.started', {
    instance_id, work_item_id: plane.work_item_id, workflow, revision: 1
  }).catch(() => {});

  return { ok: true, instance_id, job_id: job?.id ?? null };
}
