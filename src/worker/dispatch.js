// src/worker/dispatch.js
import { getCachedWorkflows } from './engine.js';
import { createInstance, updateInstance } from '../server/workflow-instances.js';
import { getQueue, QUEUES, PRIORITY_MAP } from '../server/bullmq.js';
import { getProjectByPlaneId } from '../server/db.js';

// Read at call time, not import time — tests set these in beforeEach AFTER
// import, and a worker starting before EnvironmentFile loads would otherwise
// stay deaf until restart.
function workerEventsUrl() {
  return process.env.WORKER_EVENTS_URL
    || 'http://localhost:3030/api/admin/events/publish';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// When a caller dispatches with only a UUID work_item_id and no project_id
// (Shelly's plane_dispatch_work_item with a UUID, internal pipeline retreats
// that propagate the resolved id, anything that ran resolvePlaneWorkItem
// elsewhere and lost the project_id), fan out across managed projects to
// find which one owns the work item. First Plane 200 wins. This was the bug
// behind the DEVPA-7c/-31/-36/-44 EDMS cluster: builders ran in dev-panel
// because project_id was empty, the worker fell back to PROJECT_ROOT.
let _managedProjectsCache = { at: 0, value: [] };
async function fetchManagedProjects() {
  const now = Date.now();
  if (now - _managedProjectsCache.at < 5 * 60 * 1000 && _managedProjectsCache.value.length) {
    return _managedProjectsCache.value;
  }
  const apiBase = process.env.API_BASE;
  const adminKey = process.env.ADMIN_API_KEY;
  if (!apiBase || !adminKey) return [];
  try {
    const r = await fetch(`${apiBase.replace(/\/$/, '')}/api/admin/projects`, {
      headers: { 'X-Admin-Key': adminKey },
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return [];
    const body = await r.json();
    const list = body?.projects || [];
    _managedProjectsCache = { at: now, value: list };
    return list;
  } catch { return []; }
}

async function resolveProjectIdFromWorkItemUuid(work_item_uuid) {
  const planeBase = process.env.PLANE_BASE_URL || 'https://plane.devpanl.dev';
  const planeSlug = process.env.PLANE_WORKSPACE_SLUG || 'devpanl';
  const planeKey = process.env.PLANE_API_KEY;
  if (!planeKey || !UUID_RE.test(work_item_uuid)) return null;
  const projects = await fetchManagedProjects();
  for (const p of projects) {
    if (!p.plane_project_id) continue;
    try {
      const r = await fetch(
        `${planeBase}/api/v1/workspaces/${planeSlug}/projects/${p.plane_project_id}/issues/${work_item_uuid}/`,
        { headers: { 'X-API-Key': planeKey }, signal: AbortSignal.timeout(5000) }
      );
      if (r.ok) {
        const wi = await r.json();
        if (wi?.project) return wi.project;
      }
    } catch { /* try next project */ }
  }
  return null;
}

// DEVPA-180: when running on the agents host the local SQLite is empty (the
// projects table is authoritative services-side, mounted on the devpanel-api
// container's storage volume). Resolve via /api/admin/projects/by-plane-id/:id
// when API_BASE + ADMIN_API_KEY are available; fall back to the local DB
// otherwise so unit tests and bare local dev still work.
async function lookupProjectByPlaneId(plane_project_id) {
  const apiBase = process.env.API_BASE;
  const adminKey = process.env.ADMIN_API_KEY;
  if (apiBase && adminKey) {
    const url = `${apiBase.replace(/\/$/, '')}/api/admin/projects/by-plane-id/${encodeURIComponent(plane_project_id)}`;
    let r;
    try {
      r = await fetch(url, { headers: { 'X-Admin-Key': adminKey } });
    } catch (e) {
      const err = new Error(`api_unreachable: ${e.message}`);
      err.code = 'api_unreachable';
      throw err;
    }
    if (r.status === 404) return null;
    if (!r.ok) {
      const err = new Error(`api_${r.status}`);
      err.code = `api_${r.status}`;
      throw err;
    }
    const body = await r.json().catch(() => null);
    return body || null;
  }
  // Fallback: local SQLite. Synchronous, but wrapped to keep the call
  // signature uniform — callers always await.
  return getProjectByPlaneId(plane_project_id) || null;
}

async function publishEvent(event, data) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return;
  try {
    await fetch(workerEventsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ event, data })
    });
  } catch { /* SSE is best-effort */ }
}

// Reload-aware: getCachedWorkflows() returns the parsed flows from cache only
// if no YAML on disk has changed. Fixes the silent staleness bug that wedged
// PR #17 / #18 in merge-coordinator → blocked-terminal for ~30h after the
// PR #67 YAML deploy without a worker restart.
function getFlows() { return getCachedWorkflows(); }

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
  // Caller may have only passed a UUID work_item_id (e.g. Shelly's
  // plane_dispatch_work_item('a95997ef-...') for an EDMS item). Fan out to
  // Plane to find the owning project so the projects-table lookup below
  // can route the worktree to the right repo. Skip when project_id was
  // already provided (callers that knew the project save us the round-trip).
  let resolvedProjectId = plane.project_id;
  if (!context.project_root && !resolvedProjectId && plane.work_item_id) {
    try {
      resolvedProjectId = await resolveProjectIdFromWorkItemUuid(plane.work_item_id);
    } catch { /* best-effort */ }
  }

  if (!context.project_root && resolvedProjectId) {
    let proj;
    try {
      proj = await lookupProjectByPlaneId(resolvedProjectId);
    } catch (e) {
      return { ok: false, error: `project_lookup_failed: ${e.message}` };
    }
    if (!proj?.local_path) {
      return {
        ok: false,
        error: 'project_not_linked',
        message: `No projects row with plane_project_id=${resolvedProjectId} has local_path set. Run \`dev-panel admin link-project <name> --plane-id ${resolvedProjectId}\` on the services VPS.`
      };
    }
    context = { ...context, project_root: proj.local_path };
    // Propagate the resolved project_id forward so downstream steps in
    // engine.triggerNext don't have to re-resolve.
    plane = { ...plane, project_id: resolvedProjectId };
    // Propagate the GitHub repo identity so publishWorkItem (automation.js)
    // creates the PR on the right repo. Without this, ZENO/EDMS work items
    // produced commits in the right worktree but `gh pr create` was hardcoded
    // to franckbirba/dev-panel — zero PRs ever showed up cross-repo.
    if (proj.github_owner && proj.github_repo) {
      context = {
        ...context,
        github_repo: `${proj.github_owner}/${proj.github_repo}`,
        default_branch: proj.default_branch || 'main'
      };
    }
  }

  // A UUID work_item_id that reaches this point with no project_root and no
  // resolvedProjectId means resolveProjectIdFromWorkItemUuid returned null —
  // managed-projects fan-out failed (API_BASE/ADMIN_API_KEY missing on the
  // MCP host, cache miss, Plane 4xx) or the UUID belongs to a project not in
  // the managed list. Letting the job through silently falls back to
  // PROJECT_ROOT in the worker, which routes Zeno/EDMS commits into the
  // dev-panel checkout — exit 0, no PR, no signal. Refuse loudly instead.
  // Synthetic ids (github:owner/repo#42, cycle:<id>) and test fixtures
  // (wi-d1, wi-pr4) don't match UUID_RE and keep the legacy escape hatch.
  if (!context.project_root && !resolvedProjectId && UUID_RE.test(plane.work_item_id)) {
    return {
      ok: false,
      error: 'project_unresolved',
      message: `work_item_id=${plane.work_item_id} is a UUID but no plane.project_id was provided and resolveProjectIdFromWorkItemUuid returned null. Either pass plane.project_id explicitly, or ensure API_BASE+ADMIN_API_KEY+PLANE_API_KEY are set on the dispatcher and the work item's project is in the managed projects table.`
    };
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
