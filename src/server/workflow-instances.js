// src/server/workflow-instances.js
// Orchestration state (workflow_instances) on shared Postgres.
// Shared between services API and agents-host worker (same pg, migration 003).
import { pool } from './pg.js';

// Lazy-loaded SSE broadcast (API process) AND socket.io agent-hub emit
// (worker process). On the API side broadcast() fans out to dashboard SSE
// clients. On the worker side it no-ops because there's no HTTP server,
// so emitAgentEvent() ships the same event to the hub via socket.io and
// the hub re-broadcasts to dashboards. Either path produces real-time
// updates without postgres polling.
let _broadcast = null;
let _emitAgent = null;
async function broadcast(event, data) {
  // 1. SSE fan-out (API process) — no-op in worker.
  try {
    if (_broadcast === null) {
      const m = await import('./sse.js');
      _broadcast = m.broadcast || (() => {});
    }
    _broadcast(event, data);
  } catch { /* sse not available */ }
  // 2. socket.io to hub (worker process) — no-op in API.
  try {
    if (_emitAgent === null) {
      const m = await import('../worker/agent-hub-client.js');
      _emitAgent = m.emitAgentEvent || (() => {});
    }
    _emitAgent(event, data);
  } catch { /* hub client not loaded in this process */ }
}

// Normalize a row's `metadata` field to a JSON string (the shape callers
// expect — engine.js does JSON.parse(instance.metadata)). Pg stores JSONB
// which node-postgres returns as a parsed object, so we re-stringify here.
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
  const { rows } = await pool.query(
    `INSERT INTO workflow_instances
       (work_item_id, workflow_name, revision, current_step, status,
        module_id, cycle_id, started_at, last_event_at, metadata)
     VALUES ($1, $2, 1, $3, 'running', $4, $5, $6, $6, $7::jsonb)
     RETURNING id`,
    [work_item_id, workflow_name, current_step, module_id, cycle_id, now, metaStr]
  );
  // Push a real-time event so any open dashboard tab updates immediately
  // instead of waiting for the next poll. Fire-and-forget — never block the
  // worker on the broadcast.
  broadcast('workflow:changed', {
    op: 'insert',
    id: rows[0].id,
    work_item_id, workflow_name, status: 'running', current_step,
    last_event_at: now,
  });
  return rows[0].id;
}

export async function loadInstance({ work_item_id, workflow_name }) {
  const { rows } = await pool.query(
    `SELECT * FROM workflow_instances
      WHERE work_item_id = $1 AND workflow_name = $2
      ORDER BY id DESC LIMIT 1`,
    [work_item_id, workflow_name]
  );
  return normalizeRow(rows[0]);
}

export async function loadInstanceById(id) {
  const { rows } = await pool.query(
    `SELECT * FROM workflow_instances WHERE id = $1`,
    [id]
  );
  return normalizeRow(rows[0]);
}

export async function updateInstance({ work_item_id, workflow_name }, patch) {
  const now = Date.now();
  // Single-roundtrip UPDATE against the most recent instance for this
  // (work_item, workflow) — targets the same "latest id" loadInstance picks.
  const metaStr = patch.metadata == null ? undefined
    : (typeof patch.metadata === 'string' ? patch.metadata : JSON.stringify(patch.metadata));
  const setExhausted = patch.status === 'exhausted';
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
  const updated = normalizeRow(rows[0]);
  broadcast('workflow:changed', {
    op: 'update',
    id: updated.id,
    work_item_id: updated.work_item_id,
    workflow_name: updated.workflow_name,
    status: updated.status,
    current_step: updated.current_step,
    last_event_at: now,
  });
  return updated;
}

export async function listActive() {
  const { rows } = await pool.query(
    `SELECT * FROM workflow_instances
      WHERE status IN ('running', 'awaiting_approval')
      ORDER BY last_event_at DESC`
  );
  return rows.map(normalizeRow);
}

export async function listByCycle(cycle_id) {
  const { rows } = await pool.query(
    `SELECT * FROM workflow_instances WHERE cycle_id = $1 ORDER BY last_event_at DESC`,
    [cycle_id]
  );
  return rows.map(normalizeRow);
}
