// Threads: subject-keyed conversations. Lazy-created on first access.
// Cross-platform: rows with source='web' come from the dashboard, source='telegram'
// from inbound MCP calls (Shelly), source='system' from server-emitted events.

import { getMasterDatabase } from './db.js';
import { getSubject } from './subjects.js';

const VALID_ROLES   = new Set(['user', 'shelly', 'system', 'agent']);
const VALID_SOURCES = new Set(['web', 'telegram', 'system', 'widget', 'glitchtip']);

export function getOrCreateThread(subject_type, subject_id) {
  const db = getMasterDatabase();
  const existing = db.prepare(
    `SELECT * FROM threads WHERE subject_type = ? AND subject_id = ?`
  ).get(subject_type, subject_id);
  if (existing) return existing;

  const subj = getSubject(subject_type, subject_id);
  if (!subj) throw new Error(`subject not found: ${subject_type}/${subject_id}`);

  const info = db.prepare(
    `INSERT INTO threads (subject_type, subject_id, project_id) VALUES (?, ?, ?)`
  ).run(subject_type, subject_id, subj.project_id);
  return db.prepare(`SELECT * FROM threads WHERE thread_id = ?`).get(info.lastInsertRowid);
}

export function listMessages(thread_id) {
  const db = getMasterDatabase();
  const rows = db.prepare(
    `SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC`
  ).all(thread_id);
  return rows.map(row => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null
  }));
}

export function appendMessage({ thread_id, role, source, content, telegram_message_id = null, metadata = null }) {
  if (!VALID_ROLES.has(role))     throw new Error(`invalid role: ${role}`);
  if (!VALID_SOURCES.has(source)) throw new Error(`invalid source: ${source}`);
  const db = getMasterDatabase();
  const metadataJson = metadata != null ? JSON.stringify(metadata) : null;
  const info = db.prepare(`
    INSERT INTO thread_messages (thread_id, role, source, content, telegram_message_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(thread_id, role, source, content, telegram_message_id, metadataJson);
  db.prepare(`UPDATE threads SET last_message_at = CURRENT_TIMESTAMP WHERE thread_id = ?`).run(thread_id);
  return info.lastInsertRowid;
}

// Copy messages from `source_thread_id` whose id is <= `upToMessageId`
// (or all messages if `upToMessageId` is null) into `target_thread_id`.
// Preserves role, source, content, metadata, but assigns a fresh id and
// created_at to the copies. Used by the chat-fork endpoint to seed a new
// thread with a prefix of an existing one (DEVPA-262).
//
// Returns the number of rows copied. The target thread's last_message_at
// is updated to "now" so the new thread sorts to the top in the sidebar.
export function copyMessagesIntoThread({ source_thread_id, target_thread_id, upToMessageId = null }) {
  const db = getMasterDatabase();
  const rows = upToMessageId == null
    ? db.prepare(
        `SELECT role, source, content, metadata FROM thread_messages
          WHERE thread_id = ? ORDER BY id ASC`
      ).all(source_thread_id)
    : db.prepare(
        `SELECT role, source, content, metadata FROM thread_messages
          WHERE thread_id = ? AND id <= ? ORDER BY id ASC`
      ).all(source_thread_id, upToMessageId);
  if (rows.length === 0) return 0;
  const insert = db.prepare(
    `INSERT INTO thread_messages (thread_id, role, source, content, metadata)
     VALUES (?, ?, ?, ?, ?)`
  );
  const tx = db.transaction((items) => {
    for (const r of items) insert.run(target_thread_id, r.role, r.source, r.content, r.metadata);
  });
  tx(rows);
  db.prepare(
    `UPDATE threads SET last_message_at = CURRENT_TIMESTAMP WHERE thread_id = ?`
  ).run(target_thread_id);
  return rows.length;
}

// Idempotent insert keyed on telegram_message_id (the unique partial index
// on thread_messages.telegram_message_id will reject duplicates; we swallow
// the constraint error so callers don't have to think about retries).
export function appendFromTelegram({ thread_id, role, content, telegram_message_id }) {
  if (telegram_message_id == null) {
    throw new Error('telegram_message_id required for appendFromTelegram');
  }
  try {
    return appendMessage({ thread_id, role, source: 'telegram', content, telegram_message_id });
  } catch (e) {
    if (String(e.message).includes('UNIQUE constraint failed')) return null;
    throw e;
  }
}
