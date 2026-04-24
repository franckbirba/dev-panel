// src/server/workflow-instances.js
// Orchestration state (workflow_instances) — dual-path behind
// DEVPANEL_PG_ORCHESTRATION. All exports async. Sqlite path stays intact
// for rollback; pg path reads/writes the shared Postgres so worker (agents
// host) and dashboard API (services host) see the same rows.
import { getMasterDatabase } from './db.js';
import { mirror } from './master-mirror.js';
import { pool } from './pg.js';

function pgEnabled() {
  const v = process.env.DEVPANEL_PG_ORCHESTRATION;
  return v === '1' || v === 'true';
}

// Normalize a row's `metadata` field to a JSON string (the shape callers
// expect — engine.js does JSON.parse(instance.metadata)). Sqlite stores TEXT
// already; pg stores JSONB which node-postgres returns as a parsed object.
function normalizeRow(row) {
  if (!row) return row;
  if (row.metadata && typeof row.metadata !== 'string') {
    row.metadata = JSON.stringify(row.metadata);
  }
  return row;
}

export async function createInstance({
  work_item_id, workflow_name, current_step,
  module_id = null, cycle_id = null,
  metadata = null
}) {
  const now = Date.now();
  const metaStr = metadata == null ? null
    : (typeof metadata === 'string' ? metadata : JSON.stringify(metadata));

  if (pgEnabled()) {
    const { rows } = await pool.query(
      `INSERT INTO workflow_instances
         (work_item_id, workflow_name, revision, current_step, status,
          module_id, cycle_id, started_at, last_event_at, metadata)
       VALUES ($1, $2, 1, $3, 'running', $4, $5, $6, $6, $7::jsonb)
       RETURNING id`,
      [work_item_id, workflow_name, current_step, module_id, cycle_id, now, metaStr]
    );
    return rows[0].id;
  }

  const db = getMasterDatabase();
  const info = db.prepare(
    `INSERT INTO workflow_instances
       (work_item_id, workflow_name, revision, current_step, status,
        module_id, cycle_id, started_at, last_event_at, metadata)
     VALUES (?, ?, 1, ?, 'running', ?, ?, ?, ?, ?)`
  ).run(work_item_id, workflow_name, current_step,
        module_id, cycle_id, now, now, metaStr);
  mirror('/admin/mirror/workflow-instances/create', {
    work_item_id, workflow_name, current_step,
    module_id, cycle_id, started_at: now, last_event_at: now,
    metadata: metaStr
  });
  return info.lastInsertRowid;
}

export async function loadInstance({ work_item_id, workflow_name }) {
  if (pgEnabled()) {
    const { rows } = await pool.query(
      `SELECT * FROM workflow_instances
        WHERE work_item_id = $1 AND workflow_name = $2
        ORDER BY id DESC LIMIT 1`,
      [work_item_id, workflow_name]
    );
    return normalizeRow(rows[0]);
  }
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT * FROM workflow_instances
      WHERE work_item_id = ? AND workflow_name = ?
      ORDER BY id DESC LIMIT 1`
  ).get(work_item_id, workflow_name);
}

export async function loadInstanceById(id) {
  if (pgEnabled()) {
    const { rows } = await pool.query(
      `SELECT * FROM workflow_instances WHERE id = $1`,
      [id]
    );
    return normalizeRow(rows[0]);
  }
  const db = getMasterDatabase();
  return db.prepare(`SELECT * FROM workflow_instances WHERE id = ?`).get(id);
}

export async function updateInstance({ work_item_id, workflow_name }, patch) {
  const now = Date.now();

  if (pgEnabled()) {
    // Single-roundtrip update against the most recent instance for this
    // (work_item, workflow). Matches the sqlite read-modify-write semantics
    // because we target the same "latest id" the old loadInstance() picks.
    const metaStr = patch.metadata == null ? undefined
      : (typeof patch.metadata === 'string' ? patch.metadata : JSON.stringify(patch.metadata));
    const setExhausted = patch.status === 'exhausted';

    // Build COALESCE updates so omitted fields keep their current value.
    const { rows } = await pool.query(
      `UPDATE workflow_instances
          SET revision      = COALESCE($3, revision),
              current_step  = COALESCE($4, current_step),
              status        = COALESCE($5, status),
              last_event_at = $6,
              exhausted_at  = CASE WHEN $7::boolean THEN $6 ELSE exhausted_at END,
              last_job_id   = COALESCE($8, last_job_id),
              metadata      = COALESCE($9::jsonb, metadata)
        WHERE id = (
          SELECT id FROM workflow_instances
           WHERE work_item_id = $1 AND workflow_name = $2
           ORDER BY id DESC LIMIT 1
        )
        RETURNING *`,
      [
        work_item_id, workflow_name,
        patch.revision ?? null,
        patch.current_step ?? null,
        patch.status ?? null,
        now,
        setExhausted,
        patch.last_job_id ?? null,
        metaStr ?? null
      ]
    );
    if (rows.length === 0) {
      throw new Error(`no instance for (${work_item_id}, ${workflow_name})`);
    }
    return normalizeRow(rows[0]);
  }

  const db = getMasterDatabase();
  const current = await loadInstance({ work_item_id, workflow_name });
  if (!current) throw new Error(`no instance for (${work_item_id}, ${workflow_name})`);
  const fields = { ...current, ...patch, last_event_at: now };
  if (patch.status === 'exhausted') fields.exhausted_at = now;
  db.prepare(
    `UPDATE workflow_instances
        SET revision=?, current_step=?, status=?, last_event_at=?,
            exhausted_at=?, last_job_id=?, metadata=?
      WHERE id=?`
  ).run(fields.revision, fields.current_step, fields.status, fields.last_event_at,
        fields.exhausted_at ?? null, fields.last_job_id ?? null,
        typeof fields.metadata === 'string' ? fields.metadata :
          (fields.metadata ? JSON.stringify(fields.metadata) : null),
        current.id);
  mirror('/admin/mirror/workflow-instances/update', {
    work_item_id, workflow_name,
    revision: fields.revision,
    current_step: fields.current_step,
    status: fields.status,
    last_event_at: fields.last_event_at,
    exhausted_at: fields.exhausted_at ?? null,
    last_job_id: fields.last_job_id ?? null,
    metadata: typeof fields.metadata === 'string' ? fields.metadata :
      (fields.metadata ? JSON.stringify(fields.metadata) : null)
  });
  return loadInstanceById(current.id);
}

export async function listActive() {
  if (pgEnabled()) {
    const { rows } = await pool.query(
      `SELECT * FROM workflow_instances
        WHERE status IN ('running', 'awaiting_approval')
        ORDER BY last_event_at DESC`
    );
    return rows.map(normalizeRow);
  }
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT * FROM workflow_instances
      WHERE status IN ('running', 'awaiting_approval')
      ORDER BY last_event_at DESC`
  ).all();
}

export async function listByCycle(cycle_id) {
  if (pgEnabled()) {
    const { rows } = await pool.query(
      `SELECT * FROM workflow_instances WHERE cycle_id = $1 ORDER BY last_event_at DESC`,
      [cycle_id]
    );
    return rows.map(normalizeRow);
  }
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT * FROM workflow_instances WHERE cycle_id = ? ORDER BY last_event_at DESC`
  ).all(cycle_id);
}
