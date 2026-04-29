// src/server/widget-audit.js
//
// Append-only audit log for the widget surface (DEVPA-166).
//
// Every meaningful event (incoming message, outgoing message, capture
// creation, rate-limit hit, redaction applied) writes a row to
// widget_audit. Content is hashed (SHA-256) — we never store plaintext.
// A post-incident investigator can confirm that a known piece of content
// reached the server by re-hashing it and looking for the match.

import { createHash } from 'crypto';
import { getMasterDatabase } from './db.js';

export const AUDIT_TYPES = Object.freeze({
  MESSAGE_IN:        'message_in',
  MESSAGE_OUT:       'message_out',
  CAPTURE_CREATED:   'capture_created',
  RATE_LIMITED:      'rate_limited',
  REDACTED:          'redacted'
});

const VALID_TYPES = new Set(Object.values(AUDIT_TYPES));

export function hashContent(content) {
  if (content == null) return null;
  return createHash('sha256').update(String(content)).digest('hex');
}

// Write a single audit row. Content (if provided) is hashed — never stored
// raw. Returns the inserted row id. Caller-side errors (bad type, missing
// project) throw; storage errors bubble up so the caller can log.
export function auditEvent({ project_id = null, session_id = null, type, content = null }) {
  if (!type || !VALID_TYPES.has(type)) {
    throw new Error(`audit: invalid type "${type}"`);
  }
  const db = getMasterDatabase();
  const stmt = db.prepare(
    `INSERT INTO widget_audit (project_id, session_id, type, content_hash)
     VALUES (?, ?, ?, ?)`
  );
  const result = stmt.run(project_id, session_id, type, hashContent(content));
  return result.lastInsertRowid;
}

export function listAuditForSession(session_id, { limit = 100 } = {}) {
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT id, project_id, session_id, type, content_hash, ts
       FROM widget_audit
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?`
  ).all(session_id, limit);
}
