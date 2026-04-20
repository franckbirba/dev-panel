// src/server/captures.js
//
// Franck + Shelly's triage surface. A capture is a raw thought Franck
// dumps into the dashboard or Telegram — a bug he noticed, a feature he
// wants, a half-formed idea. Shelly picks it up, asks clarifying questions
// via capture_messages, and when the item is ripe she promotes it to a
// Plane work item (populating plane_work_item_id + plane_sequence_id).
//
// Lifecycle:
//   new        — just captured, Shelly has not triaged yet
//   triaging   — Shelly is asking questions, awaiting Franck's reply
//   promoted   — turned into a Plane work item (see plane_*)
//   dropped    — decided not to pursue; kept for the record
//
// Status transitions are free-form on purpose — Shelly decides.

import { randomUUID } from 'crypto';
import { getMasterDatabase } from './db.js';

export function createCapture({ project_id, content, kind = 'idea', created_by = 'franck' }) {
  const db = getMasterDatabase();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO captures (id, project_id, kind, content, status, created_by)
     VALUES (?, ?, ?, ?, 'new', ?)`
  ).run(id, project_id, kind, content, created_by);
  // Every capture starts with a user message so the thread view has content.
  db.prepare(
    `INSERT INTO capture_messages (capture_id, role, content) VALUES (?, 'user', ?)`
  ).run(id, content);
  return getCapture(id);
}

export function getCapture(id) {
  const db = getMasterDatabase();
  const capture = db.prepare(`SELECT * FROM captures WHERE id = ?`).get(id);
  if (!capture) return null;
  const messages = db.prepare(
    `SELECT id, role, content, metadata, created_at
       FROM capture_messages WHERE capture_id = ? ORDER BY created_at ASC, id ASC`
  ).all(id);
  return { ...capture, messages };
}

export function listCaptures({ project_id, status = null, limit = 100 }) {
  const db = getMasterDatabase();
  let sql = `
    SELECT c.*,
           (SELECT COUNT(*) FROM capture_messages m WHERE m.capture_id = c.id) AS message_count,
           (SELECT content FROM capture_messages m WHERE m.capture_id = c.id
              ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
           (SELECT role FROM capture_messages m WHERE m.capture_id = c.id
              ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_role
    FROM captures c
    WHERE c.project_id = ?
  `;
  const params = [project_id];
  if (status) { sql += ` AND c.status = ?`; params.push(status); }
  sql += ` ORDER BY c.updated_at DESC, c.created_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function listPendingForAllProjects({ limit = 50 } = {}) {
  const db = getMasterDatabase();
  return db.prepare(`
    SELECT c.*, p.name AS project_name
      FROM captures c
      JOIN projects p ON p.id = c.project_id
     WHERE c.status IN ('new', 'triaging')
     ORDER BY c.created_at ASC
     LIMIT ?
  `).all(limit);
}

export function addCaptureMessage({ capture_id, role, content, metadata = null }) {
  const db = getMasterDatabase();
  const info = db.prepare(
    `INSERT INTO capture_messages (capture_id, role, content, metadata)
     VALUES (?, ?, ?, ?)`
  ).run(capture_id, role, content, metadata ? JSON.stringify(metadata) : null);
  // Touch updated_at — and bump status to 'triaging' on Shelly's first reply
  // so the dashboard badge reflects active conversation.
  if (role === 'shelly') {
    db.prepare(
      `UPDATE captures
          SET updated_at = CURRENT_TIMESTAMP,
              status = CASE WHEN status = 'new' THEN 'triaging' ELSE status END
        WHERE id = ?`
    ).run(capture_id);
  } else {
    db.prepare(
      `UPDATE captures SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(capture_id);
  }
  return info.lastInsertRowid;
}

export function updateCapture(id, patch) {
  const db = getMasterDatabase();
  const allowed = ['status', 'kind', 'plane_work_item_id', 'plane_sequence_id'];
  const fields = [], values = [];
  for (const k of allowed) {
    if (k in patch) { fields.push(`${k} = ?`); values.push(patch[k]); }
  }
  if (!fields.length) return getCapture(id);
  fields.push(`updated_at = CURRENT_TIMESTAMP`);
  db.prepare(`UPDATE captures SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
  return getCapture(id);
}

export function deleteCapture(id) {
  const db = getMasterDatabase();
  db.prepare(`DELETE FROM captures WHERE id = ?`).run(id);
}
