// src/server/workflow-instances.js
import { getMasterDatabase } from './db.js';

export function createInstance({
  work_item_id, workflow_name, current_step,
  module_id = null, cycle_id = null,
  metadata = null
}) {
  const db = getMasterDatabase();
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO workflow_instances
       (work_item_id, workflow_name, revision, current_step, status,
        module_id, cycle_id, started_at, last_event_at, metadata)
     VALUES (?, ?, 1, ?, 'running', ?, ?, ?, ?, ?)`
  ).run(work_item_id, workflow_name, current_step,
        module_id, cycle_id, now, now,
        metadata ? JSON.stringify(metadata) : null);
  return info.lastInsertRowid;
}

export function loadInstance({ work_item_id, workflow_name }) {
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT * FROM workflow_instances
      WHERE work_item_id = ? AND workflow_name = ?
      ORDER BY id DESC LIMIT 1`
  ).get(work_item_id, workflow_name);
}

export function loadInstanceById(id) {
  const db = getMasterDatabase();
  return db.prepare(`SELECT * FROM workflow_instances WHERE id = ?`).get(id);
}

export function updateInstance({ work_item_id, workflow_name }, patch) {
  const db = getMasterDatabase();
  const current = loadInstance({ work_item_id, workflow_name });
  if (!current) throw new Error(`no instance for (${work_item_id}, ${workflow_name})`);
  const fields = { ...current, ...patch, last_event_at: Date.now() };
  if (patch.status === 'exhausted') fields.exhausted_at = Date.now();
  db.prepare(
    `UPDATE workflow_instances
        SET revision=?, current_step=?, status=?, last_event_at=?,
            exhausted_at=?, last_job_id=?, metadata=?
      WHERE id=?`
  ).run(fields.revision, fields.current_step, fields.status, fields.last_event_at,
        fields.exhausted_at || null, fields.last_job_id || null,
        typeof fields.metadata === 'string' ? fields.metadata :
          (fields.metadata ? JSON.stringify(fields.metadata) : null),
        current.id);
  return loadInstanceById(current.id);
}

export function listActive() {
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT * FROM workflow_instances
      WHERE status IN ('running', 'awaiting_approval')
      ORDER BY last_event_at DESC`
  ).all();
}

export function listByCycle(cycle_id) {
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT * FROM workflow_instances WHERE cycle_id = ? ORDER BY last_event_at DESC`
  ).all(cycle_id);
}
