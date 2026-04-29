// src/server/widget-rate-limit.js
//
// Rate limits for the widget surface (DEVPA-166).
//
// Three independent caps:
//   - 30 messages/min per session
//   - 200 messages/day per session
//   - 1000 concurrent sessions per project (a session is "active" if it
//     produced any audit row in the last SESSION_ACTIVE_WINDOW_SEC window;
//     30 minutes is the default, configurable per call for tests).
//
// Counting is done against widget_audit rows of type='message_in' for the
// per-session caps and distinct session_id for the per-project cap. Using
// the audit log as the source of truth means rate-limit state survives
// restarts and is consistent across processes (no in-memory drift).

import { getMasterDatabase } from './db.js';
import { AUDIT_TYPES } from './widget-audit.js';

export const LIMITS = Object.freeze({
  PER_SESSION_PER_MIN: 30,
  PER_SESSION_PER_DAY: 200,
  PER_PROJECT_CONCURRENT_SESSIONS: 1000,
  SESSION_ACTIVE_WINDOW_SEC: 30 * 60   // 30 minutes
});

// Count rows of a given type for a session within the last `windowSec` seconds.
function countForSession(db, session_id, windowSec) {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM widget_audit
      WHERE session_id = ?
        AND type = ?
        AND ts >= datetime('now', ?)`
  ).get(session_id, AUDIT_TYPES.MESSAGE_IN, `-${windowSec} seconds`);
  return row?.n ?? 0;
}

// Distinct active sessions on a project = sessions with any audit row in
// the active window. New sessions don't enter the count until they emit
// their first event, so the very first request from a 1001st session is
// still admitted. The follow-up request would be the one rejected — same
// behaviour as the per-session caps.
function countActiveSessionsForProject(db, project_id, windowSec) {
  const row = db.prepare(
    `SELECT COUNT(DISTINCT session_id) AS n
       FROM widget_audit
      WHERE project_id = ?
        AND session_id IS NOT NULL
        AND ts >= datetime('now', ?)`
  ).get(project_id, `-${windowSec} seconds`);
  return row?.n ?? 0;
}

// checkRateLimit — returns { allowed: true } when the request can proceed,
// or { allowed: false, reason, retryAfter } when it should be 429'd.
// `reason` is one of: per_session_per_min | per_session_per_day |
// per_project_concurrent_sessions. `retryAfter` is in seconds — clients
// surface it as the HTTP Retry-After header.
//
// `limits` is exposed for tests; production callers omit it and pick up
// the LIMITS defaults.
export function checkRateLimit({ project_id, session_id }, limits = LIMITS) {
  if (!session_id) {
    throw new Error('rate-limit: session_id required');
  }
  const db = getMasterDatabase();

  // Per-session per-minute. We count BEFORE inserting the new event, so
  // when count >= max the new request is the one too many.
  const minuteCount = countForSession(db, session_id, 60);
  if (minuteCount >= limits.PER_SESSION_PER_MIN) {
    return {
      allowed: false,
      reason: 'per_session_per_min',
      retryAfter: 60,
      counts: { minute: minuteCount }
    };
  }

  // Per-session per-day.
  const dayCount = countForSession(db, session_id, 24 * 3600);
  if (dayCount >= limits.PER_SESSION_PER_DAY) {
    return {
      allowed: false,
      reason: 'per_session_per_day',
      retryAfter: 24 * 3600,
      counts: { day: dayCount }
    };
  }

  // Per-project concurrent sessions. Only checked when this is a session
  // we haven't seen before within the active window — established sessions
  // can keep posting even if the cap is otherwise full.
  if (project_id) {
    const sessionAlreadyActive = db.prepare(
      `SELECT 1 FROM widget_audit
        WHERE project_id = ? AND session_id = ?
          AND ts >= datetime('now', ?)
        LIMIT 1`
    ).get(project_id, session_id, `-${limits.SESSION_ACTIVE_WINDOW_SEC} seconds`);

    if (!sessionAlreadyActive) {
      const active = countActiveSessionsForProject(db, project_id, limits.SESSION_ACTIVE_WINDOW_SEC);
      if (active >= limits.PER_PROJECT_CONCURRENT_SESSIONS) {
        return {
          allowed: false,
          reason: 'per_project_concurrent_sessions',
          retryAfter: limits.SESSION_ACTIVE_WINDOW_SEC,
          counts: { active_sessions: active }
        };
      }
    }
  }

  return { allowed: true };
}
