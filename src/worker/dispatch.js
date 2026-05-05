// src/worker/dispatch.js
import { loadWorkflows } from './engine.js';
import { createInstance, updateInstance } from '../server/workflow-instances.js';
import { getQueue, QUEUES, PRIORITY_MAP } from '../server/bullmq.js';
import { getProjectByPlaneId } from '../server/db.js';

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

  // Resolve the target repo checkout from the Plane project_id. Builders run
  // in this directory; without it they'd push EDMS/Zeno commits onto
  // dev-panel itself. project_root is propagated through context so every
  // downstream step (engine.triggerNext copies context forward) inherits it.
  //
  // If plane.project_id is set but no projects row matches OR the row has
  // no local_path, refuse to enqueue. This is the recurring failure mode
  // (see commits 4bcf5ff, cfa12df) — silently falling back to PROJECT_ROOT
  // routed Zeno/EDMS commits to dev-panel itself. Caller can override by
  // passing context.project_root explicitly (test fixtures, reviewer/qa
  // retreats that re-use a previous step's worktree).
  if (!context.project_root && plane.project_id) {
    let proj;
    try {
      proj = getProjectByPlaneId(plane.project_id);
    } catch (e) {
      return { ok: false, error: `project_lookup_failed: ${e.message}` };
    }
    if (!proj?.local_path) {
      return {
        ok: false,
        error: 'project_not_linked',
        message: `No projects row with plane_project_id=${plane.project_id} has local_path set. Run \`dev-panel admin link-project <name> --plane-id ${plane.project_id}\` on the services VPS.`
      };
    }
    context = { ...context, project_root: proj.local_path };
  }

  let instance_id;
  try {
    instance_id = await createInstance({
      work_item_id: plane.work_item_id,
      workflow_name: workflow,
      current_step: firstAgent,
      module_id: plane.module_id || null,
      cycle_id: plane.cycle_id || null
    });
  } catch (e) {
    // Unique-index collision varies by backend: sqlite code, pg '23505'.
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === '23505') {
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
      await updateInstance(
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
