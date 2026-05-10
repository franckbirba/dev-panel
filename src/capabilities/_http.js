// Shared HTTP helpers for capability handlers. Capabilities call into the
// devpanel admin API (`X-Admin-Key`) and Plane direct (`X-API-Key`).
// All responses are JSON.

const API_BASE = (process.env.API_BASE || 'https://devpanl.dev').replace(/\/$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

const PLANE_BASE_URL = (process.env.PLANE_BASE_URL || 'https://plane.devpanl.dev').replace(/\/$/, '');
const PLANE_WORKSPACE_SLUG = process.env.PLANE_WORKSPACE_SLUG || 'devpanl';
const PLANE_API_KEY = process.env.PLANE_API_KEY || process.env.PLANE_API_TOKEN || '';

const T = (ms = 8000) => AbortSignal.timeout(ms);

export async function adminGet(path) {
  if (!ADMIN_API_KEY) throw new Error('ADMIN_API_KEY not configured');
  const r = await fetch(`${API_BASE}${path}`, {
    headers: { 'X-Admin-Key': ADMIN_API_KEY },
    signal: T(),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`GET ${path} → ${r.status}${body ? ': ' + body.slice(0, 200) : ''}`);
  }
  return r.json();
}

export async function adminPatch(path, body) {
  if (!ADMIN_API_KEY) throw new Error('ADMIN_API_KEY not configured');
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'X-Admin-Key': ADMIN_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: T(),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`PATCH ${path} → ${r.status}${t ? ': ' + t.slice(0, 200) : ''}`);
  }
  return r.json();
}

// ─── Plane direct ────────────────────────────────────────────────────────────

export async function planeWorkspaceGet(path) {
  if (!PLANE_API_KEY) throw new Error('PLANE_API_KEY not configured');
  const url = `${PLANE_BASE_URL}/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}${path}`;
  const r = await fetch(url, {
    headers: { 'X-API-Key': PLANE_API_KEY },
    signal: T(),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`plane GET ${path} → ${r.status}${t ? ': ' + t.slice(0, 200) : ''}`);
  }
  return r.json();
}

export async function planeProjectGet(projectId, path) {
  if (!PLANE_API_KEY) throw new Error('PLANE_API_KEY not configured');
  const url = `${PLANE_BASE_URL}/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${projectId}${path}`;
  const r = await fetch(url, {
    headers: { 'X-API-Key': PLANE_API_KEY },
    signal: T(),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`plane GET ${path} → ${r.status}${t ? ': ' + t.slice(0, 200) : ''}`);
  }
  return r.json();
}

const SEQ_RE = /^([A-Z][A-Z0-9]*)-(\d+)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a sequence id like "DEVPA-209" or a UUID to a Plane work item.
 * Sequence path: workspace-level identifier endpoint.
 * UUID path: fan-out across managed projects (the workspace endpoint
 * doesn't accept UUIDs; we don't know which project owns it). Returns
 * the raw Plane work-item object or null.
 */
export async function resolvePlaneWorkItem(idOrSeq) {
  if (!PLANE_API_KEY) return null;
  if (SEQ_RE.test(idOrSeq)) {
    try {
      return await planeWorkspaceGet(`/work-items/${encodeURIComponent(idOrSeq)}/`);
    } catch {
      return null;
    }
  }
  if (UUID_RE.test(idOrSeq)) {
    // Fan-out — get managed projects, try each.
    try {
      const data = await adminGet('/api/admin/projects');
      const projects = data.projects || data || [];
      for (const p of projects) {
        if (!p.plane_project_id) continue;
        try {
          return await planeProjectGet(
            p.plane_project_id,
            `/issues/${encodeURIComponent(idOrSeq)}/`
          );
        } catch {
          /* try next */
        }
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

export { API_BASE, PLANE_BASE_URL, PLANE_WORKSPACE_SLUG };
