// master-mirror.js — one-directional dual-write from the worker host (agents)
// to the dashboard host (services). The worker keeps writing its local SQLite
// (so engine.js reads stay synchronous and fast), AND if DEVPANEL_REMOTE_MASTER
// is set, fire-and-forget POSTs the same write to the services API so the
// dashboard DB stays in sync.
//
// One-directional, best-effort. A failed mirror call is logged but never
// blocks the worker. The right long-term fix is to move these tables to
// shared Postgres (see infra/migrations/003-orchestration-pg.sql) — this
// module is the bridge until that lands.

const BASE = process.env.DEVPANEL_REMOTE_MASTER; // e.g. "https://devpanl.dev/api"
const KEY  = process.env.ADMIN_API_KEY;

export function mirrorEnabled() {
  return Boolean(BASE && KEY);
}

export function mirror(path, body) {
  if (!mirrorEnabled()) return;
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': KEY },
    body: JSON.stringify(body)
  }).catch(err => {
    // Best-effort: the worker's local SQLite is the source of truth for its
    // own engine state. Mirror failures only mean the dashboard lags.
    console.error('[mirror] failed', path, err.message);
  });
}
