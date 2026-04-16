// src/worker/backlog-puller.js
//
// Continuous Plane backlog → work-item workflow dispatcher.
//
// Runs inside the worker process as a setInterval. Each tick lists every
// Plane issue whose state is in the configured "ready for agents" group
// (default: "unstarted" / Todo) and calls enqueueWorkflowStart for it.
// The unique partial index on workflow_instances enforces one active
// workflow per work-item; already-running items are dropped with
// `already_running` and logged quietly.
//
// This is what makes the team 24/7: the queue never runs dry as long as
// there are Plane Todos.
//
// Env:
//   BACKLOG_PULL_INTERVAL_MS   default 900000 (15 min)
//   BACKLOG_PULL_ENABLED       "true"/"false"  default "false" — opt-in
//   BACKLOG_PULL_STATE_GROUPS  comma-separated, default "unstarted"
//   BACKLOG_PULL_LABEL         only pull issues with this label (e.g. "agent-ready")
//   BACKLOG_PULL_MAX_PER_TICK  safety cap; default 3
//   PLANE_BASE_URL             e.g. https://plane.devpanl.dev
//   PLANE_API_KEY
//   PLANE_WORKSPACE_SLUG       e.g. devpanl
//   PLANE_PROJECT_ID           UUID of the project to pull from

const PLANE_BASE_URL = (process.env.PLANE_BASE_URL || '').replace(/\/$/, '');
const PLANE_API_KEY = process.env.PLANE_API_KEY || '';
const PLANE_WORKSPACE_SLUG = process.env.PLANE_WORKSPACE_SLUG || '';
const PLANE_PROJECT_ID = process.env.PLANE_PROJECT_ID || '';

const INTERVAL_MS = parseInt(process.env.BACKLOG_PULL_INTERVAL_MS || '900000', 10);
const ENABLED = (process.env.BACKLOG_PULL_ENABLED ?? 'false') === 'true';
const STATE_GROUPS = (process.env.BACKLOG_PULL_STATE_GROUPS || 'unstarted')
  .split(',').map(s => s.trim()).filter(Boolean);
const LABEL_FILTER = (process.env.BACKLOG_PULL_LABEL || '').trim();
const MAX_PER_TICK = parseInt(process.env.BACKLOG_PULL_MAX_PER_TICK || '3', 10);

function hasPlaneConfig() {
  return Boolean(PLANE_BASE_URL && PLANE_API_KEY && PLANE_WORKSPACE_SLUG && PLANE_PROJECT_ID);
}

async function planeFetch(path) {
  const url = `${PLANE_BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { 'X-API-Key': PLANE_API_KEY, Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`Plane ${path} → ${res.status}`);
  return res.json();
}

async function listStatesInGroups(groups) {
  const data = await planeFetch(
    `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/states/`
  );
  const all = data.results || data; // Plane returns either shape depending on endpoint
  return all.filter(s => groups.includes(s.group)).map(s => s.id);
}

async function resolveLabelId(name) {
  if (!name) return null;
  const data = await planeFetch(
    `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/labels/`
  );
  const all = data.results || data;
  const match = all.find(l => l.name === name);
  return match ? match.id : null;
}

async function listIssuesByStates(stateIds) {
  const all = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) { // cap pagination at 10 pages (~500 items) per tick
    const qs = new URLSearchParams({ per_page: '50' });
    if (cursor) qs.set('cursor', cursor);
    const data = await planeFetch(
      `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/issues/?${qs}`
    );
    const rows = data.results || [];
    for (const i of rows) {
      if (stateIds.includes(i.state)) all.push(i);
    }
    if (!data.next_page_results) break;
    cursor = data.next_cursor;
  }
  return all;
}

async function tick() {
  if (!ENABLED) return;
  if (!hasPlaneConfig()) {
    console.warn('[BacklogPuller] Plane config missing, skipping tick');
    return;
  }

  const { enqueueWorkflowStart } = await import('./dispatch.js');

  let stateIds;
  try {
    stateIds = await listStatesInGroups(STATE_GROUPS);
  } catch (err) {
    console.error('[BacklogPuller] list states failed:', err.message);
    return;
  }
  if (!stateIds.length) {
    console.warn(`[BacklogPuller] no states matched groups=${STATE_GROUPS.join(',')}`);
    return;
  }

  let labelId = null;
  if (LABEL_FILTER) {
    try {
      labelId = await resolveLabelId(LABEL_FILTER);
    } catch (err) {
      console.error('[BacklogPuller] resolve label failed:', err.message);
      return;
    }
    if (!labelId) {
      console.warn(`[BacklogPuller] label "${LABEL_FILTER}" not found in project — skipping tick`);
      return;
    }
  }

  let issues;
  try {
    issues = await listIssuesByStates(stateIds);
  } catch (err) {
    console.error('[BacklogPuller] list issues failed:', err.message);
    return;
  }

  if (labelId) {
    issues = issues.filter(i => Array.isArray(i.labels) && i.labels.includes(labelId));
  }

  // Cap per tick to avoid a burst of 100 enqueues if the backlog is fresh.
  const batch = issues.slice(0, MAX_PER_TICK);
  let dispatched = 0, alreadyRunning = 0, failed = 0;
  for (const issue of batch) {
    try {
      const out = await enqueueWorkflowStart({
        workflow: 'work-item',
        plane: {
          work_item_id: issue.id,
          module_id: Array.isArray(issue.module) ? issue.module[0] : (issue.module || null),
          cycle_id: issue.cycle || null
        },
        work_item: { sequence_id: issue.sequence_id, name: issue.name }
      });
      if (out.ok) dispatched++;
      else if (out.error === 'already_running') alreadyRunning++;
      else { failed++; console.warn(`[BacklogPuller] DEVPA-${issue.sequence_id}: ${out.error}`); }
    } catch (err) {
      failed++;
      console.error(`[BacklogPuller] DEVPA-${issue.sequence_id} dispatch threw:`, err.message);
    }
  }

  console.log(
    `[BacklogPuller] tick done — seen=${issues.length} batched=${batch.length} ` +
    `dispatched=${dispatched} already=${alreadyRunning} failed=${failed}`
  );
}

let _timer = null;

export function startBacklogPuller() {
  if (!ENABLED) {
    console.log('[BacklogPuller] disabled via BACKLOG_PULL_ENABLED=false');
    return;
  }
  if (!hasPlaneConfig()) {
    console.warn(
      '[BacklogPuller] missing Plane env (PLANE_BASE_URL / PLANE_API_KEY / PLANE_WORKSPACE_SLUG / PLANE_PROJECT_ID) — not starting'
    );
    return;
  }
  console.log(
    `[BacklogPuller] every ${Math.round(INTERVAL_MS / 1000)}s, states=${STATE_GROUPS.join(',')}, ` +
    `label=${LABEL_FILTER || '(any)'}, max/tick=${MAX_PER_TICK}, project=${PLANE_PROJECT_ID}`
  );
  // Fire once at startup, then on interval. Drift-free via setTimeout chain.
  const run = async () => {
    try { await tick(); } catch (err) { console.error('[BacklogPuller] tick threw:', err); }
    _timer = setTimeout(run, INTERVAL_MS);
  };
  _timer = setTimeout(run, 5000); // 5s after boot so worker is ready
}

export function stopBacklogPuller() {
  if (_timer) clearTimeout(_timer);
  _timer = null;
}
