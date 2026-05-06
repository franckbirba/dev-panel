// src/mcp/projects.js
// Helpers shared by the MCP team-routing tools (get_team_labels,
// get_team_member, route_ticket, route_capture).
//
// Why separate from server.js: these were referenced by the original
// commit (812c43e) but never defined — DEVPA-177 surfaced the missing
// resolveProjectByName / projectFetch when Shelly tried to look up a
// team for routing. Keeping them in their own module makes them
// importable from a vitest unit test.
//
// Resolution order:
//   1. Local SQLite via getProjectByName / getProjectById — covers the
//      developer / services-host case where storage/projects.db is
//      authoritative.
//   2. Fallback to /api/admin/projects with X-Admin-Key — covers the
//      agents-host case where local SQLite is empty (same workaround
//      list_projects already uses).
//
// Both paths return the FULL project row including api_key, since
// projectFetch needs it to call per-project routes (X-API-Key auth).

import { getProjectByName, getProjectById } from '../server/db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function apiBase() {
  return (process.env.API_BASE || 'https://devpanl.dev').replace(/\/$/, '');
}

export async function resolveProjectByName(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const isUuid = UUID_RE.test(trimmed);

  // 1. Local SQLite
  try {
    const local = isUuid ? getProjectById(trimmed) : getProjectByName(trimmed);
    if (local) return local;
  } catch {
    // master DB may not be initialized (e.g. agents host) — fall through.
  }

  // 2. API fallback
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return null;

  const r = await fetch(`${apiBase()}/api/admin/projects`, {
    headers: { 'X-Admin-Key': adminKey }
  });
  if (!r.ok) return null;
  const body = await r.json().catch(() => ({}));
  const projects = Array.isArray(body?.projects) ? body.projects : [];
  if (isUuid) return projects.find(p => p.id === trimmed) || null;
  return projects.find(p => p.name === trimmed) || null;
}

export async function projectFetch(proj, path, init = {}) {
  if (!proj?.api_key) {
    throw new Error('projectFetch: project row is missing api_key');
  }
  const url = `${apiBase()}/api${path.startsWith('/') ? path : `/${path}`}`;
  const headers = {
    'X-API-Key': proj.api_key,
    'Content-Type': 'application/json',
    ...(init.headers || {})
  };
  const r = await fetch(url, { ...init, headers });
  let data;
  const text = await r.text();
  try { data = text ? JSON.parse(text) : null; }
  catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}
