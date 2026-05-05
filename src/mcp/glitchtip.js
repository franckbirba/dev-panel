// GlitchTip — read/resolve issues via the Sentry-compatible API.
//
// Pairs with the inbound bridge in src/server/webhooks-glitchtip.js. The
// webhook turns alerts into captures (push from GlitchTip → DevPanel); these
// MCP tools give Shelly + ephemeral agents the matching pull/write surface
// (DevPanel → GlitchTip) so a triager can fetch the latest event payload by
// issue id and an ephemeral agent can resolve the issue once a fix has
// merged.
//
// Auth: Bearer <GLITCHTIP_API_TOKEN>. The token is read+write (org:admin /
// project:admin / project:write per CLAUDE.md bootstrap §6). 401/403 surface
// loudly — silent empty payloads would mask a token rotation.
//
// Out of scope here: list issues, comments, alert rules, project creation
// (DEVPA-170 owns the auto-wiring of new projects). Add tools when the need
// is concrete.

const DEFAULT_BASE = 'https://glitchtip.devpanl.dev';
const FETCH_TIMEOUT_MS = 10000;

function glitchtipConfig() {
  const base = (process.env.GLITCHTIP_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const token = process.env.GLITCHTIP_API_TOKEN;
  if (!token) {
    throw new Error('GLITCHTIP_API_TOKEN must be set (Bearer token from glitchtip.devpanl.dev → Profile → Auth Tokens)');
  }
  return { base, token };
}

async function authedFetch(path, init = {}) {
  const cfg = glitchtipConfig();
  const url = `${cfg.base}${path}`;
  const headers = {
    'Authorization': `Bearer ${cfg.token}`,
    'Accept': 'application/json',
    ...(init.headers || {})
  };
  return await fetch(url, {
    ...init,
    headers,
    signal: init.signal || AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
}

async function jsonOrThrow(res, label) {
  if (res.ok) {
    if (res.status === 204) return null;
    return await res.json();
  }
  // Surface auth failures explicitly so a rotated token doesn't look like a
  // missing issue. The GlitchTip API returns plain text on 401/403.
  const body = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${label}: HTTP ${res.status} — check GLITCHTIP_API_TOKEN scopes (org:admin / project:write). ${body.slice(0, 200)}`);
  }
  if (res.status === 404) {
    throw new Error(`${label}: HTTP 404 — issue not found or not in this organization. ${body.slice(0, 200)}`);
  }
  throw new Error(`${label}: HTTP ${res.status} ${body.slice(0, 500)}`);
}

// Pull the structured exception entry out of a Sentry/GlitchTip event. The
// payload format is `event.entries: [{type, data}, ...]` — we look for the
// `exception` and `breadcrumbs` entries because those are the parts an LLM
// triager actually reads. `tags` lives at the top of the event, not in
// `entries`.
function extractEventDetails(event) {
  if (!event) return null;
  const entries = Array.isArray(event.entries) ? event.entries : [];
  const exceptionEntry = entries.find(e => e?.type === 'exception');
  const breadcrumbsEntry = entries.find(e => e?.type === 'breadcrumbs');

  let exception = null;
  let stack = null;
  if (exceptionEntry?.data?.values?.length) {
    const values = exceptionEntry.data.values;
    exception = values.map(v => ({
      type: v.type ?? null,
      value: v.value ?? null,
      module: v.module ?? null
    }));
    // Surface the most-recent frame stack from the first exception so callers
    // don't have to dig through nested entries. Sentry orders frames
    // oldest→newest; reverse so the throwing frame comes first for humans.
    const frames = values[0]?.stacktrace?.frames;
    if (Array.isArray(frames)) {
      stack = [...frames].reverse().slice(0, 30).map(f => ({
        filename: f.filename ?? null,
        function: f.function ?? null,
        lineno: f.lineno ?? null,
        colno: f.colno ?? null,
        in_app: f.in_app ?? null
      }));
    }
  }

  const breadcrumbs = breadcrumbsEntry?.data?.values?.slice(-20) ?? null;

  return {
    message: event.message ?? event.title ?? null,
    exception,
    stack,
    breadcrumbs,
    tags: Array.isArray(event.tags) ? event.tags : null
  };
}

export async function getIssue(orgSlug, issueId) {
  if (!orgSlug) throw new Error('getIssue: org_slug is required');
  if (!issueId) throw new Error('getIssue: issue_id is required');

  const issueRes = await authedFetch(`/api/0/organizations/${encodeURIComponent(orgSlug)}/issues/${encodeURIComponent(issueId)}/`);
  const issue = await jsonOrThrow(issueRes, 'getIssue');

  // Pull the latest event in parallel with the issue metadata. If the latest
  // event endpoint 404s (issue exists but has no event yet — rare but
  // possible right after creation) we just return last_event=null instead of
  // failing the whole call.
  let lastEvent = null;
  try {
    const eventRes = await authedFetch(`/api/0/organizations/${encodeURIComponent(orgSlug)}/issues/${encodeURIComponent(issueId)}/events/latest/`);
    if (eventRes.ok) {
      const event = await eventRes.json();
      lastEvent = extractEventDetails(event);
    } else if (eventRes.status === 401 || eventRes.status === 403) {
      // Auth failure on the event call but not the issue call would be
      // surprising — surface it loudly rather than swallowing.
      const body = await eventRes.text().catch(() => '');
      throw new Error(`getIssue.latestEvent: HTTP ${eventRes.status} ${body.slice(0, 200)}`);
    }
  } catch (err) {
    // Re-throw if this is the auth error we just constructed.
    if (/HTTP 40[13]/.test(err.message)) throw err;
    // Otherwise tolerate — the issue payload is still useful on its own.
    lastEvent = null;
  }

  return {
    title: issue?.title ?? null,
    culprit: issue?.culprit ?? null,
    level: issue?.level ?? null,
    status: issue?.status ?? null,
    last_event: lastEvent
  };
}

export async function resolveIssue(orgSlug, issueId) {
  if (!orgSlug) throw new Error('resolveIssue: org_slug is required');
  if (!issueId) throw new Error('resolveIssue: issue_id is required');

  const res = await authedFetch(`/api/0/organizations/${encodeURIComponent(orgSlug)}/issues/${encodeURIComponent(issueId)}/`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'resolved' })
  });
  const out = await jsonOrThrow(res, 'resolveIssue');
  return {
    issue_id: String(issueId),
    status: out?.status ?? 'resolved'
  };
}

export const __internal = {
  glitchtipConfig,
  extractEventDetails,
  authedFetch
};
