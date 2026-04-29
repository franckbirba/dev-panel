// src/server/widget-sessions.js
//
// Session lifecycle for the chat widget API. A widget session is created on
// first widget load (POST /api/widget/sessions, project X-API-Key auth) and
// the response carries a 24h sliding bearer token used to authorize the
// SSE stream + subsequent message/capture writes.
//
// The session_id is the public URL identifier (path param). The
// session_token is the bearer secret. Both are random URL-safe strings;
// the token is the only auth used by /sessions/:id/* routes.
//
// Token TTL is 24h sliding — every successful authorize() call extends
// expiry by another 24h. A cleanup loop runs in process to mark expired
// sessions as closed; reads ignore expired rows.

import { randomBytes } from 'crypto';
import { getMasterDatabase } from './db.js';
import { upsertSubject } from './subjects.js';
import { getOrCreateThread } from './threads.js';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// Two distinct random ids per session: session_id (public, in URL) and
// session_token (bearer secret). Both URL-safe base64 trimmed to alphabetic
// length, distinct enough to never collide in practice (256 bits of entropy
// each).
function newRandomId(prefix = '') {
  const raw = randomBytes(24).toString('base64url'); // 32 chars URL-safe
  return prefix ? `${prefix}_${raw}` : raw;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

export function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

function newExpiry() {
  return new Date(Date.now() + TOKEN_TTL_MS).toISOString();
}

// Clamp integer between [min, max]; returns null for non-numeric input.
function clampInt(v, min, max) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function trimString(v, max = 255) {
  if (v == null) return null;
  if (typeof v !== 'string') return null;
  return v.slice(0, max);
}

// Create a brand-new widget session row. Spawns a thread under
// subject_type='widget_session' so messages have somewhere to land.
// Returns the row shape used in API responses.
export function createWidgetSession({ project_id, user_agent = null, route = null, viewport_w = null, viewport_h = null, locale = null }) {
  const db = getMasterDatabase();
  const id = newRandomId();
  const session_id = newRandomId('ws');
  const session_token = newRandomId('wt');
  const expires_at = newExpiry();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO widget_sessions
         (id, project_id, session_id, session_token, token_expires_at,
          user_agent, route, viewport_w, viewport_h, locale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, project_id, session_id, session_token, expires_at,
      trimString(user_agent),
      trimString(route, 1024),
      clampInt(viewport_w, 0, 100000),
      clampInt(viewport_h, 0, 100000),
      trimString(locale, 32)
    );

    upsertSubject({
      subject_type: 'widget_session',
      subject_id: id,
      project_id,
      title: route ? `widget @ ${String(route).slice(0, 80)}` : 'widget session'
    });

    const thread = getOrCreateThread('widget_session', id);
    db.prepare(`UPDATE widget_sessions SET thread_id = ? WHERE id = ?`).run(thread.thread_id, id);
  });
  tx();

  return getWidgetSessionById(id);
}

export function getWidgetSessionById(id) {
  const db = getMasterDatabase();
  return db.prepare(`SELECT * FROM widget_sessions WHERE id = ?`).get(id) ?? null;
}

export function getWidgetSessionBySessionId(session_id) {
  const db = getMasterDatabase();
  return db.prepare(`SELECT * FROM widget_sessions WHERE session_id = ?`).get(session_id) ?? null;
}

// Validate a bearer token + session_id pair. Returns the session row on
// success and refreshes both token_expires_at and last_seen_at (sliding
// expiry). Returns null on any auth failure: missing token, mismatched
// session, expired, or closed.
export function authorizeBySessionToken({ session_id, token }) {
  if (!isValidSessionId(session_id)) return null;
  if (!token || typeof token !== 'string') return null;
  const db = getMasterDatabase();
  const row = db.prepare(
    `SELECT * FROM widget_sessions WHERE session_id = ?`
  ).get(session_id);
  if (!row) return null;
  if (row.session_token !== token) return null;
  if (row.closed_at) return null;
  if (new Date(row.token_expires_at).getTime() < Date.now()) return null;

  // Sliding refresh: bump expiry and last_seen_at.
  const expires_at = newExpiry();
  db.prepare(
    `UPDATE widget_sessions
        SET token_expires_at = ?, last_seen_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(expires_at, row.id);

  return { ...row, token_expires_at: expires_at };
}

// Close (soft-delete) a session. Used when host app explicitly logs out
// the user; the bearer becomes invalid immediately.
export function closeWidgetSession(id) {
  const db = getMasterDatabase();
  db.prepare(
    `UPDATE widget_sessions SET closed_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(id);
}
