// Plane Pages — read/write via the internal /api/workspaces/.../pages/* mount.
//
// Plane v1.3.0 does NOT expose Pages on the public /api/v1/ surface (no
// page.py in plane/api/urls/). The internal /api/ mount has full CRUD but
// is session-only (BaseSessionAuthentication, no API-token path). So we run
// a service-account session: PLANE_SHELLY_EMAIL/PASSWORD log in once, hold
// the session-id + csrftoken cookies in memory, refresh on 401.
//
// Important quirks confirmed against the live Plane v1.3.0 instance:
//   * GET /pages/<id>/description/ returns binary HocusPocus (Yjs) state —
//     application/octet-stream, NOT html. The page metadata at GET
//     /pages/<id>/ carries `description_html` for human-readable reads.
//   * PATCH /pages/<id>/description/ accepts {"description_html": "..."} but
//     overwrites the live collaborative state. Concurrent UI editors will
//     overwrite our writes. Treat one-shot PATCH as last-writer-wins.
//   * DELETE on a page that is not archived returns 400 with
//     "The page should be archived before deleting". archivePage() first,
//     then deletePage(), or use deletePage({ force: true }) to chain.
//
// Pinned to Plane v1.3.0 (release 2026-04-06). When Plane ships v1 page
// endpoints (issues #7319, #8598) we can swap the URL prefix and drop the
// session login.

import { resolveWorkItem as _unused } from './plane-attachments.js'; // ensures shared module compiles together

const DEFAULT_BASE = 'https://plane.devpanl.dev';
const DEFAULT_SLUG = 'devpanl';
const SESSION_TTL_MS = 6 * 24 * 60 * 60 * 1000; // re-login every 6 days; cookie lives 7
const FETCH_TIMEOUT_MS = 10000;

function planeConfig() {
  const base = (process.env.PLANE_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const slug = process.env.PLANE_WORKSPACE_SLUG || DEFAULT_SLUG;
  const email = process.env.PLANE_SHELLY_EMAIL;
  const password = process.env.PLANE_SHELLY_PASSWORD;
  if (!email || !password) {
    throw new Error('PLANE_SHELLY_EMAIL and PLANE_SHELLY_PASSWORD must be set (service account for Pages access)');
  }
  return { base, slug, email, password };
}

let session = null; // { csrfCookie, sessionCookie, csrfToken, expiresAt }

function parseSetCookie(header, name) {
  if (!header) return null;
  const parts = Array.isArray(header) ? header : String(header).split(/,(?=\s*[a-zA-Z0-9_-]+=)/);
  for (const p of parts) {
    const m = p.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (m) return m[1];
  }
  return null;
}

async function fetchSetCookies(url, init = {}) {
  // node fetch normalizes headers; getSetCookie() reliably returns an array.
  const res = await fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.raw?.()['set-cookie'] || []);
  return { res, setCookies };
}

async function login(cfg) {
  // Step 1: GET /auth/get-csrf-token/ — sets csrftoken cookie + returns token in JSON.
  const tokenUrl = `${cfg.base}/auth/get-csrf-token/`;
  const { res: tokenRes, setCookies: csrfCookies } = await fetchSetCookies(tokenUrl, { method: 'GET' });
  if (!tokenRes.ok) throw new Error(`Plane CSRF init failed: HTTP ${tokenRes.status}`);
  const { csrf_token } = await tokenRes.json();
  const csrfCookie = parseSetCookie(csrfCookies, 'csrftoken');
  if (!csrf_token || !csrfCookie) throw new Error('Plane CSRF init returned no token/cookie');

  // Step 2: POST /auth/sign-in/ form-encoded — sets session-id cookie.
  const form = new URLSearchParams({ email: cfg.email, password: cfg.password }).toString();
  const { res: signRes, setCookies: signCookies } = await fetchSetCookies(`${cfg.base}/auth/sign-in/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': csrf_token,
      'Origin': cfg.base,
      'Referer': `${cfg.base}/`,
      'Cookie': `csrftoken=${csrfCookie}`
    },
    body: form,
    redirect: 'manual'
  });
  if (signRes.status !== 302 && signRes.status !== 200) {
    throw new Error(`Plane sign-in failed: HTTP ${signRes.status} ${await signRes.text().catch(() => '')}`);
  }
  const newCsrf = parseSetCookie(signCookies, 'csrftoken') || csrfCookie;
  const sessionCookie = parseSetCookie(signCookies, 'session-id');
  if (!sessionCookie) throw new Error('Plane sign-in returned no session-id cookie');

  return {
    csrfCookie: newCsrf,
    sessionCookie,
    csrfToken: csrf_token,
    expiresAt: Date.now() + SESSION_TTL_MS
  };
}

async function ensureSession(cfg) {
  if (session && session.expiresAt > Date.now()) return session;
  session = await login(cfg);
  return session;
}

async function authedFetch(path, init = {}) {
  const cfg = planeConfig();
  let s = await ensureSession(cfg);
  const url = `${cfg.base}${path}`;

  const buildInit = () => {
    const headers = {
      'Cookie': `csrftoken=${s.csrfCookie}; session-id=${s.sessionCookie}`,
      'Origin': cfg.base,
      'Referer': `${cfg.base}/`,
      ...(init.headers || {})
    };
    const method = (init.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      headers['X-CSRFToken'] = s.csrfToken;
    }
    return { ...init, headers, signal: init.signal || AbortSignal.timeout(FETCH_TIMEOUT_MS) };
  };

  let res = await fetch(url, buildInit());
  if (res.status === 401 || res.status === 403) {
    // Session may have expired — log in once and retry.
    session = null;
    s = await ensureSession(cfg);
    res = await fetch(url, buildInit());
  }
  return res;
}

function pagesBase(projectId) {
  const cfg = planeConfig();
  return `/api/workspaces/${cfg.slug}/projects/${projectId}/pages`;
}

async function jsonOrThrow(res, label) {
  if (res.ok) {
    if (res.status === 204) return null;
    return await res.json();
  }
  const body = await res.text().catch(() => '');
  throw new Error(`${label} failed: HTTP ${res.status} ${body.slice(0, 500)}`);
}

export async function listPages(projectId) {
  const res = await authedFetch(`${pagesBase(projectId)}/`);
  return await jsonOrThrow(res, 'listPages');
}

export async function getPage(projectId, pageId) {
  const res = await authedFetch(`${pagesBase(projectId)}/${pageId}/`);
  return await jsonOrThrow(res, 'getPage');
}

// description_html lives on the metadata payload. The /description/ endpoint
// returns binary Yjs state which is not useful to agents.
export async function getPageHtml(projectId, pageId) {
  const page = await getPage(projectId, pageId);
  return page?.description_html ?? '';
}

export async function createPage(projectId, { name, description_html = '', access = 0, parent = null } = {}) {
  if (!name) throw new Error('createPage: name is required');
  const res = await authedFetch(`${pagesBase(projectId)}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description_html, access, parent })
  });
  return await jsonOrThrow(res, 'createPage');
}

export async function updatePage(projectId, pageId, fields) {
  const allowed = ['name', 'access', 'color', 'parent', 'logo_props'];
  const payload = {};
  for (const k of allowed) if (k in fields) payload[k] = fields[k];
  if (Object.keys(payload).length === 0) throw new Error('updatePage: no updatable fields supplied');
  const res = await authedFetch(`${pagesBase(projectId)}/${pageId}/`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return await jsonOrThrow(res, 'updatePage');
}

// Last-writer-wins. PATCH overwrites the HocusPocus collaborative state with
// the supplied HTML — concurrent UI editors will see their edits clobbered.
export async function updatePageContent(projectId, pageId, descriptionHtml) {
  if (typeof descriptionHtml !== 'string') {
    throw new Error('updatePageContent: descriptionHtml must be a string');
  }
  const res = await authedFetch(`${pagesBase(projectId)}/${pageId}/description/`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description_html: descriptionHtml })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`updatePageContent failed: HTTP ${res.status} ${body.slice(0, 500)}`);
  }
  return { ok: true };
}

export async function archivePage(projectId, pageId) {
  const res = await authedFetch(`${pagesBase(projectId)}/${pageId}/archive/`, { method: 'POST' });
  return await jsonOrThrow(res, 'archivePage');
}

export async function unarchivePage(projectId, pageId) {
  const res = await authedFetch(`${pagesBase(projectId)}/${pageId}/archive/`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    const body = await res.text().catch(() => '');
    throw new Error(`unarchivePage failed: HTTP ${res.status} ${body.slice(0, 500)}`);
  }
  return { ok: true };
}

// Plane requires a page to be archived before deletion. With force=true we
// archive then delete; otherwise we fail loudly so callers know.
export async function deletePage(projectId, pageId, { force = false } = {}) {
  if (force) {
    try { await archivePage(projectId, pageId); } catch (_) { /* idempotent */ }
  }
  const res = await authedFetch(`${pagesBase(projectId)}/${pageId}/`, { method: 'DELETE' });
  if (res.status === 204) return { ok: true };
  const body = await res.text().catch(() => '');
  throw new Error(`deletePage failed: HTTP ${res.status} ${body.slice(0, 500)}`);
}

// Smoke probe used at MCP server start. Returns { ok, status, body? }.
// Never throws — boot must continue even if Pages are degraded.
export async function pagesHealthcheck(projectId) {
  try {
    const res = await authedFetch(`${pagesBase(projectId)}/`);
    if (res.ok) return { ok: true, status: res.status };
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: body.slice(0, 200) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Test seam.
export const __internal = { login, ensureSession, parseSetCookie, planeConfig, _resetSession: () => { session = null; } };
