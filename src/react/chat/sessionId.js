// Persisted widget session credentials. The server owns session_id (URL
// segment) and session_token (bearer); both are returned by POST
// /api/widget/sessions and cached here so a returning visitor reuses the
// same thread until the 24h sliding token expires.

export const SESSION_STORAGE_KEY = 'devpanel.widget.session';

function readStored() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.session_id || !parsed.session_token) return null;
    return parsed;
  } catch { return null; }
}

function writeStored(value) {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(value)); } catch { /* private mode */ }
}

export function clearStoredSession() {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* private mode */ }
}

function isFresh(stored) {
  if (!stored) return false;
  if (!stored.token_expires_at) return true;
  const t = Date.parse(stored.token_expires_at);
  if (!Number.isFinite(t)) return true;
  return t - Date.now() > 60_000;
}

// Bootstrap (or reuse) a widget session on the server. Returns
// { session_id, session_token, thread_id, token_expires_at }. Throws on
// network/auth failure so the caller can surface a connection error.
export async function bootstrapWidgetSession({ apiUrl, apiKey, route, locale, fetchImpl } = {}) {
  const cached = readStored();
  if (isFresh(cached)) return cached;

  const f = fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) throw new Error('fetch is unavailable');
  if (!apiUrl) throw new Error('apiUrl is required');
  if (!apiKey) throw new Error('apiKey is required');

  const body = {
    route: route ?? (typeof window !== 'undefined' ? window.location.pathname : null),
    locale: locale ?? (typeof navigator !== 'undefined' ? navigator.language : null),
    viewport_w: typeof window !== 'undefined' ? window.innerWidth : null,
    viewport_h: typeof window !== 'undefined' ? window.innerHeight : null,
  };

  const res = await f(`${apiUrl}/api/widget/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`session bootstrap failed: ${res.status}`);
  const data = await res.json();
  const stored = {
    session_id: data.session_id,
    session_token: data.session_token,
    thread_id: data.thread_id,
    token_expires_at: data.token_expires_at,
  };
  writeStored(stored);
  return stored;
}
