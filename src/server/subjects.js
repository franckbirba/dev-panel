// Subjects: cross-cutting registry of "things signals can be about".
// A subject row is upserted on first appearance (in any feed) so it can
// carry the user-driven priority lane. Single source of truth for
// (subject_type, subject_id) → priority.

import { getMasterDatabase } from './db.js';

const VALID_PRIORITIES = new Set(['now', 'today', 'later', null]);
// 'dashboard' is the synthetic per-SSO-user subject for the chat-first
// dashboard's freeform thread (DEVPA-204 part 1). Each dashboard subject
// row is keyed by the user's email, has no project_id, and exists only
// to satisfy the threads.subject_id FK.
const VALID_SUBJECT_TYPES = new Set(['work_item', 'capture', 'ticket', 'pr', 'deploy', 'job', 'widget_session', 'dashboard']);

export function upsertSubject({ subject_type, subject_id, project_id, title }) {
  if (!VALID_SUBJECT_TYPES.has(subject_type)) {
    throw new Error(`invalid subject_type: ${subject_type}`);
  }
  const db = getMasterDatabase();
  db.prepare(`
    INSERT INTO subjects (subject_type, subject_id, project_id, title)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(subject_type, subject_id) DO UPDATE SET
      title = excluded.title,
      project_id = excluded.project_id
  `).run(subject_type, subject_id, project_id, title ?? null);
}

export function getSubject(subject_type, subject_id) {
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT * FROM subjects WHERE subject_type = ? AND subject_id = ?`
  ).get(subject_type, subject_id) || null;
}

export function setPriority(subject_type, subject_id, priority) {
  if (!VALID_PRIORITIES.has(priority)) {
    throw new Error(`invalid priority: ${priority}`);
  }
  const db = getMasterDatabase();
  const row = getSubject(subject_type, subject_id);
  if (!row) throw new Error(`subject not found: ${subject_type}/${subject_id}`);
  db.prepare(`
    UPDATE subjects
       SET priority = ?, priority_set_at = CURRENT_TIMESTAMP
     WHERE subject_type = ? AND subject_id = ?
  `).run(priority, subject_type, subject_id);
}
