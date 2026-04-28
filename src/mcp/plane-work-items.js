// Plane work items — filter by assignee.
//
// Workaround for Plane self-hosted (makeplane/plane-backend:stable) which
// does not expose POST /api/v1/workspaces/{slug}/work-items/advanced-search/.
// That endpoint returns 403 on self-hosted, breaking any filtered query
// (assignee_ids, state_ids, etc.) from plane-mcp-server.
//
// Instead we use the legacy GET /issues/ endpoint with ?assignees= for
// server-side filtering. If the self-hosted instance ignores that param,
// we fall back to fetching all issues and filtering client-side.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function planeConfig() {
  const base = (process.env.PLANE_BASE_URL || 'https://plane.devpanl.dev').replace(/\/$/, '');
  const slug = process.env.PLANE_WORKSPACE_SLUG || 'devpanl';
  const key = process.env.PLANE_API_KEY || process.env.PLANE_API_TOKEN || '';
  if (!key) throw new Error('PLANE_API_KEY (or PLANE_API_TOKEN) is not configured');
  return { base, slug, key };
}

function headers(key) {
  return { 'X-API-Key': key, 'User-Agent': 'dev-panel/plane-work-items' };
}

export async function resolveProjectId(hint, { base, slug, key }) {
  if (UUID_RE.test(hint)) return hint;
  const res = await fetch(
    `${base}/api/v1/workspaces/${slug}/projects/`,
    { headers: headers(key), signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new Error(`Plane projects lookup failed: HTTP ${res.status}`);
  const list = await res.json();
  const rows = list.results || list;
  const match = rows.find(p =>
    p.identifier?.toLowerCase() === String(hint).toLowerCase() ||
    p.name?.toLowerCase() === String(hint).toLowerCase()
  );
  if (!match) throw new Error(`No Plane project matches "${hint}"`);
  return match.id;
}

export async function resolveAssigneeId(assignee, { base, slug, key }) {
  if (UUID_RE.test(assignee)) return assignee;
  const res = await fetch(
    `${base}/api/v1/workspaces/${slug}/members/`,
    { headers: headers(key), signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new Error(`Workspace members lookup failed: HTTP ${res.status}`);
  const data = await res.json();
  const members = data.results || data;
  const needle = assignee.toLowerCase();
  const match = members.find(m => {
    const mem = m.member || m;
    return mem.email?.toLowerCase() === needle ||
           mem.display_name?.toLowerCase() === needle ||
           mem.first_name?.toLowerCase() === needle;
  });
  if (!match) throw new Error(`No workspace member matches "${assignee}"`);
  const mem = match.member || match;
  return mem.id;
}

export async function fetchStates(projectId, { base, slug, key }) {
  const res = await fetch(
    `${base}/api/v1/workspaces/${slug}/projects/${projectId}/states/`,
    { headers: headers(key), signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new Error(`States lookup failed: HTTP ${res.status}`);
  const data = await res.json();
  const states = data.results || data;
  const map = {};
  for (const s of states) map[s.id] = s.group;
  return map;
}

async function fetchAllAndFilter(projectId, assigneeId, cfg) {
  const url = `${cfg.base}/api/v1/workspaces/${cfg.slug}/projects/${projectId}/issues/?per_page=100`;
  const res = await fetch(url, { headers: headers(cfg.key), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Issues fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  const all = data.results || data;
  return all.filter(i => (i.assignee_ids || i.assignees || []).includes(assigneeId));
}

export async function listWorkItemsByAssignee({ project, assignee, state_group, limit = 25 }) {
  const cfg = planeConfig();
  const projectId = await resolveProjectId(project, cfg);
  const assigneeId = await resolveAssigneeId(assignee, cfg);

  // Try server-side filtering via ?assignees= param
  const url = `${cfg.base}/api/v1/workspaces/${cfg.slug}/projects/${projectId}/issues/?assignees=${assigneeId}&per_page=${limit}`;
  const res = await fetch(url, { headers: headers(cfg.key), signal: AbortSignal.timeout(10000) });

  let items;
  if (res.ok) {
    const data = await res.json();
    const raw = data.results || data;
    // Verify server actually filtered — if raw contains items NOT assigned to
    // assigneeId, the server ignored the param and we must filter client-side.
    const filtered = raw.filter(i => (i.assignee_ids || i.assignees || []).includes(assigneeId));
    if (filtered.length === raw.length || raw.length === 0) {
      items = filtered;
    } else {
      items = await fetchAllAndFilter(projectId, assigneeId, cfg);
    }
  } else {
    // ?assignees= param not supported — full fetch + client-side filter
    items = await fetchAllAndFilter(projectId, assigneeId, cfg);
  }

  // Optional state_group filter (always client-side via states lookup)
  if (state_group) {
    const stateMap = await fetchStates(projectId, cfg);
    items = items.filter(i => stateMap[i.state] === state_group);
  }

  items = items.slice(0, limit);

  return items.map(i => ({
    id: i.id,
    sequence_id: i.sequence_id,
    name: i.name,
    state_id: i.state,
    assignee_ids: i.assignee_ids || i.assignees || [],
    priority: i.priority,
    updated_at: i.updated_at,
    url: `${cfg.base}/${cfg.slug}/projects/${projectId}/issues/${i.id}`
  }));
}

export const __internal = { resolveProjectId, resolveAssigneeId, fetchStates, fetchAllAndFilter, UUID_RE };
