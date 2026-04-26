// Batch-fetch Plane work-item metadata (title, sequence_id, state, priority,
// project) for a list of work_item_ids and return a {uuid: meta} map. Caches
// per-work-item lookups for 5 minutes so the work-items dashboard doesn't
// hammer Plane on every refresh.

const CACHE = new Map();
const TTL_MS = 5 * 60 * 1000;

function planeConfig() {
  const base = (process.env.PLANE_BASE_URL || 'https://plane.devpanl.dev').replace(/\/$/, '');
  const slug = process.env.PLANE_WORKSPACE_SLUG || 'devpanl';
  const key = process.env.PLANE_API_KEY || process.env.PLANE_API_TOKEN || '';
  if (!key) return null;
  return { base, slug, key };
}

let projectsCache = null;
let projectsCacheAt = 0;
let statesCache = new Map(); // project_id -> {state_id: state_obj}
let statesCacheAt = new Map();

async function listProjects(cfg) {
  if (projectsCache && Date.now() - projectsCacheAt < TTL_MS) return projectsCache;
  const r = await fetch(
    `${cfg.base}/api/v1/workspaces/${cfg.slug}/projects/`,
    { headers: { 'X-API-Key': cfg.key }, signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) throw new Error(`projects HTTP ${r.status}`);
  const data = await r.json();
  projectsCache = data.results || data || [];
  projectsCacheAt = Date.now();
  return projectsCache;
}

async function getStates(cfg, projectId) {
  if (statesCache.has(projectId) && Date.now() - (statesCacheAt.get(projectId) || 0) < TTL_MS) {
    return statesCache.get(projectId);
  }
  const r = await fetch(
    `${cfg.base}/api/v1/workspaces/${cfg.slug}/projects/${projectId}/states/`,
    { headers: { 'X-API-Key': cfg.key }, signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) return new Map();
  const data = await r.json();
  const rows = data.results || data || [];
  const map = new Map();
  for (const s of rows) map.set(s.id, { name: s.name, group: s.group, color: s.color });
  statesCache.set(projectId, map);
  statesCacheAt.set(projectId, Date.now());
  return map;
}

async function fetchOne(cfg, projects, uuid) {
  for (const proj of projects) {
    try {
      const r = await fetch(
        `${cfg.base}/api/v1/workspaces/${cfg.slug}/projects/${proj.id}/issues/${uuid}/`,
        { headers: { 'X-API-Key': cfg.key }, signal: AbortSignal.timeout(5000) }
      );
      if (r.ok) {
        const wi = await r.json();
        const states = await getStates(cfg, proj.id);
        const state = states.get(wi.state) || {};
        return {
          uuid,
          title: wi.name || null,
          sequence_id: wi.sequence_id || null,
          identifier: proj.identifier || null,
          project_id: proj.id,
          project_name: proj.name,
          priority: wi.priority || null,
          state_name: state.name || null,
          state_group: state.group || null,
          state_color: state.color || null,
          plane_url: `${cfg.base}/${cfg.slug}/projects/${proj.id}/work-items/${wi.sequence_id}/`,
          completed_at: wi.completed_at || null
        };
      }
    } catch { /* try next project */ }
  }
  return { uuid, title: null };
}

export async function enrichWorkItems(uuids) {
  const cfg = planeConfig();
  if (!cfg || !uuids?.length) return new Map();

  // Cache hits + collect what's still missing.
  const out = new Map();
  const todo = [];
  const now = Date.now();
  for (const uuid of uuids) {
    const hit = CACHE.get(uuid);
    if (hit && now - hit.at < TTL_MS) out.set(uuid, hit.meta);
    else todo.push(uuid);
  }
  if (!todo.length) return out;

  let projects;
  try { projects = await listProjects(cfg); }
  catch { return out; }

  // Limit concurrency — Plane can be slow under load.
  const CONCURRENCY = 4;
  let i = 0;
  async function worker() {
    while (i < todo.length) {
      const uuid = todo[i++];
      try {
        const meta = await fetchOne(cfg, projects, uuid);
        CACHE.set(uuid, { at: Date.now(), meta });
        out.set(uuid, meta);
      } catch {
        out.set(uuid, { uuid, title: null });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  return out;
}

export function clearPlaneCache() {
  CACHE.clear();
  projectsCache = null;
  statesCache.clear();
  statesCacheAt.clear();
}
