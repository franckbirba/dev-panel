// src/server/captures.js
//
// Franck + Shelly's triage surface. A capture is a raw thought Franck
// dumps into the dashboard or Telegram — a bug he noticed, a feature he
// wants, a half-formed idea. Shelly picks it up, asks clarifying questions,
// and when the item is ripe she promotes it to a Plane work item
// (populating plane_work_item_id + plane_sequence_id).
//
// Lifecycle:
//   new        — just captured, Shelly has not triaged yet
//   triaging   — Shelly is asking questions, awaiting Franck's reply
//   promoted   — turned into a Plane work item (see plane_*)
//   dropped    — decided not to pursue; kept for the record
//
// Messages live in thread_messages under subject_type='capture'. Replies
// posted via POST /api/threads/capture/:id/messages push to Telegram so
// Shelly hears them.

import { randomUUID } from 'crypto';
import { getMasterDatabase } from './db.js';
import { upsertSubject } from './subjects.js';
import { getOrCreateThread, appendMessage, listMessages } from './threads.js';

export function createCapture({ project_id, content, kind = 'idea', created_by = 'franck', reporter = null, environment = null }) {
  const db = getMasterDatabase();
  const id = randomUUID();

  const rep = normalizeReporter(reporter);
  const env = (typeof environment === 'string' && environment.length > 0) ? environment : null;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO captures
         (id, project_id, kind, content, status, created_by,
          reporter_id, reporter_name, reporter_email, reporter_extra,
          environment)
       VALUES (?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)`
    ).run(
      id, project_id, kind, content, created_by,
      rep.id, rep.name, rep.email, rep.extra,
      env
    );

    upsertSubject({
      subject_type: 'capture',
      subject_id: id,
      project_id,
      title: content.slice(0, 120)
    });

    const thread = getOrCreateThread('capture', id);
    appendMessage({
      thread_id: thread.thread_id,
      role: 'user',
      source: 'web',
      content
    });
  });
  tx();

  return getCapture(id);
}

// Split a host-provided reporter object into column values + a JSON extras
// blob. Returns { id, name, email, extra } with all fields string|null.
// Non-object input → all nulls. Fields truncated to 255 chars.
function normalizeReporter(reporter) {
  const empty = { id: null, name: null, email: null, extra: null };
  if (!reporter || typeof reporter !== 'object' || Array.isArray(reporter)) return empty;
  const trunc = (v) => (v == null ? null : String(v).slice(0, 255));
  const { id = null, name = null, email = null, ...rest } = reporter;
  const extraKeys = Object.keys(rest);
  const extra = extraKeys.length ? JSON.stringify(rest) : null;
  return { id: trunc(id), name: trunc(name), email: trunc(email), extra };
}

export function getCapture(id) {
  const db = getMasterDatabase();
  const capture = db.prepare(`SELECT * FROM captures WHERE id = ?`).get(id);
  if (!capture) return null;
  const thread = db.prepare(
    `SELECT thread_id FROM threads WHERE subject_type='capture' AND subject_id=?`
  ).get(id);
  // Map message_id → latest outbound row so the UI can show delivery state
  // for each user reply ("delivered to Telegram", "still pending", "failed").
  // Without this, Franck has no way to know whether his message reached
  // Shelly when she's slow to answer.
  const deliveries = thread
    ? Object.fromEntries(
        db.prepare(
          `SELECT thread_message_id, status, transport, error, delivered_at
             FROM telegram_outbound
            WHERE subject_type='capture' AND subject_id=?
            ORDER BY id DESC`
        ).all(id).map(d => [d.thread_message_id, d])
      )
    : {};
  const messages = thread
    ? listMessages(thread.thread_id).map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        metadata: m.metadata ?? null,
        created_at: m.created_at,
        delivery: deliveries[m.id] || null
      }))
    : [];
  return { ...capture, reporter: assembleReporter(capture), messages };
}

// Build a single reporter object from the four columns. null if no
// reporter fields were populated.
function assembleReporter(row) {
  const { reporter_id, reporter_name, reporter_email, reporter_extra } = row;
  if (reporter_id == null && reporter_name == null && reporter_email == null && reporter_extra == null) return null;
  let extras = {};
  if (reporter_extra) {
    try { extras = JSON.parse(reporter_extra) || {}; } catch { extras = {}; }
  }
  return {
    ...(reporter_id    != null ? { id: reporter_id }       : {}),
    ...(reporter_name  != null ? { name: reporter_name }   : {}),
    ...(reporter_email != null ? { email: reporter_email } : {}),
    ...extras
  };
}

export function listCaptures({ project_id, status = null, reporter_id = null, environment = null, limit = 100 }) {
  const db = getMasterDatabase();
  let sql = `
    SELECT c.*,
           COALESCE((SELECT COUNT(*) FROM thread_messages tm
                       JOIN threads t ON t.thread_id=tm.thread_id
                      WHERE t.subject_type='capture' AND t.subject_id=c.id), 0) AS message_count,
           (SELECT tm.content FROM thread_messages tm
              JOIN threads t ON t.thread_id=tm.thread_id
             WHERE t.subject_type='capture' AND t.subject_id=c.id
             ORDER BY tm.created_at DESC, tm.id DESC LIMIT 1) AS last_message,
           (SELECT tm.role FROM thread_messages tm
              JOIN threads t ON t.thread_id=tm.thread_id
             WHERE t.subject_type='capture' AND t.subject_id=c.id
             ORDER BY tm.created_at DESC, tm.id DESC LIMIT 1) AS last_role
      FROM captures c
     WHERE c.project_id = ?
  `;
  const params = [project_id];
  if (status)      { sql += ` AND c.status = ?`;      params.push(status); }
  if (reporter_id) { sql += ` AND c.reporter_id = ?`; params.push(reporter_id); }
  if (environment) { sql += ` AND c.environment = ?`; params.push(environment); }
  sql += ` ORDER BY c.updated_at DESC, c.created_at DESC LIMIT ?`;
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  return rows.map(r => ({ ...r, reporter: assembleReporter(r) }));
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
  const tx = db.transaction(() => {
    // threads cascades to thread_messages. subjects is independent.
    db.prepare(
      `DELETE FROM threads WHERE subject_type='capture' AND subject_id=?`
    ).run(id);
    db.prepare(
      `DELETE FROM subjects WHERE subject_type='capture' AND subject_id=?`
    ).run(id);
    db.prepare(`DELETE FROM captures WHERE id = ?`).run(id);
  });
  tx();
}
