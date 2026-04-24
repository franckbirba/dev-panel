#!/usr/bin/env node
// scripts/backfill-sqlite-to-pg.mjs
//
// One-shot migration: copy orchestration rows from the services projects.db
// (SQLite — the "master" db; misnamed) into the shared Postgres (`agent_memory`
// db). Idempotent via
// ON CONFLICT DO NOTHING so you can re-run freely — the pg target is the
// authoritative store once DEVPANEL_PG_ORCHESTRATION=1 flips.
//
// Tables migrated:
//   workflow_instances, agent_job_log, agent_job_events, agent_memory_writes
//
// Run on the services VPS, where the sqlite lives under DEVPANEL_STORAGE and
// pg is on 10.0.0.2. Expected envs: DEVPANEL_STORAGE, PG_HOST, PG_PORT,
// PG_USER, PG_PASSWORD, PG_DATABASE.
//
// Usage:
//   DEVPANEL_STORAGE=/home/deploy/projects/dev-panel/storage \
//   PG_HOST=10.0.0.2 PG_USER=affine PG_PASSWORD=... PG_DATABASE=agent_memory \
//   node scripts/backfill-sqlite-to-pg.mjs

import Database from 'better-sqlite3';
import pg from 'pg';
import { join } from 'path';
import { existsSync } from 'fs';

const { Pool } = pg;

const STORAGE = process.env.DEVPANEL_STORAGE;
if (!STORAGE) {
  console.error('DEVPANEL_STORAGE is required');
  process.exit(1);
}

// The "master" db in the project's db.js is actually called projects.db —
// it holds the projects registry AND the orchestration tables (migration 001).
const dbPath = join(STORAGE, 'projects.db');
if (!existsSync(dbPath)) {
  console.error(`no sqlite projects.db at ${dbPath}`);
  process.exit(1);
}

const sqlite = new Database(dbPath, { readonly: true });

const pool = new Pool({
  host: process.env.PG_HOST || '10.0.0.2',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  user: process.env.PG_USER || 'affine',
  password: process.env.PG_PASSWORD || '',
  database: process.env.PG_DATABASE || 'agent_memory',
  max: 4
});

// Chunk size: balances single-roundtrip throughput against prepared-statement
// parameter limits (pg caps at 65535 params; largest row has 10 cols = 6500
// rows/batch headroom).
const BATCH = 1000;

function log(msg) {
  console.log(`[backfill] ${msg}`);
}

// Sqlite DATETIME text → ISO string. Sqlite default is "YYYY-MM-DD HH:MM:SS"
// in UTC; pg accepts that directly as TIMESTAMPTZ (treats naive as UTC with
// our env default). We normalize to explicit ISO for safety.
function toIso(v) {
  if (v == null) return null;
  if (typeof v === 'number') return new Date(v).toISOString();
  // "2026-04-24 05:09:32" → "2026-04-24T05:09:32Z"
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s)) {
    return s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z');
  }
  return s;
}

async function copyWorkflowInstances() {
  const rows = sqlite.prepare(`SELECT * FROM workflow_instances`).all();
  log(`workflow_instances: ${rows.length} rows in sqlite`);
  if (rows.length === 0) return 0;

  // Note: pg id is BIGSERIAL. We preserve the sqlite id so engine references
  // (metadata.parent_instance_id) stay valid after cutover, and so the
  // running/awaiting_approval unique index lands on the right rows.
  let copied = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = [];
    const params = [];
    chunk.forEach((r, idx) => {
      const off = idx * 11;
      values.push(`($${off+1},$${off+2},$${off+3},$${off+4},$${off+5},$${off+6},$${off+7},$${off+8},$${off+9},$${off+10},$${off+11}::jsonb)`);
      params.push(
        r.id, r.work_item_id, r.workflow_name, r.revision, r.current_step,
        r.status, r.module_id, r.cycle_id, r.started_at, r.last_event_at,
        r.metadata // sqlite stores JSON as text; pg accepts text cast to jsonb
      );
    });
    // exhausted_at + last_job_id done via a second update pass below so the
    // primary INSERT stays simple. We skip null columns.
    const sql = `
      INSERT INTO workflow_instances
        (id, work_item_id, workflow_name, revision, current_step, status,
         module_id, cycle_id, started_at, last_event_at, metadata)
      VALUES ${values.join(',')}
      ON CONFLICT (id) DO NOTHING`;
    const r = await pool.query(sql, params);
    copied += r.rowCount;
  }

  // Patch exhausted_at + last_job_id for rows that have them.
  const patchable = rows.filter(r => r.exhausted_at != null || r.last_job_id != null);
  for (const r of patchable) {
    await pool.query(
      `UPDATE workflow_instances
          SET exhausted_at = COALESCE($2, exhausted_at),
              last_job_id  = COALESCE($3, last_job_id)
        WHERE id = $1`,
      [r.id, r.exhausted_at, r.last_job_id]
    );
  }

  // Advance the BIGSERIAL past the copied ids so new inserts don't collide.
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('workflow_instances','id'),
                   GREATEST((SELECT COALESCE(MAX(id), 0) FROM workflow_instances), 1))`
  );

  log(`workflow_instances: inserted ${copied}, skipped ${rows.length - copied} (already present)`);
  return copied;
}

async function copyJobLog() {
  const rows = sqlite.prepare(`SELECT * FROM agent_job_log`).all();
  log(`agent_job_log: ${rows.length} rows in sqlite`);
  if (rows.length === 0) return 0;

  let copied = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = [];
    const params = [];
    chunk.forEach((r, idx) => {
      const off = idx * 8;
      values.push(`($${off+1},$${off+2},$${off+3},$${off+4},$${off+5},$${off+6},$${off+7},$${off+8}::timestamptz)`);
      params.push(r.id, r.job_id, r.agent, r.step, r.status, r.error, r.duration_ms, toIso(r.timestamp));
    });
    const sql = `
      INSERT INTO agent_job_log (id, job_id, agent, step, status, error, duration_ms, timestamp)
      VALUES ${values.join(',')}
      ON CONFLICT (id) DO NOTHING`;
    const r = await pool.query(sql, params);
    copied += r.rowCount;
  }
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('agent_job_log','id'),
                   GREATEST((SELECT COALESCE(MAX(id), 0) FROM agent_job_log), 1))`
  );
  log(`agent_job_log: inserted ${copied}, skipped ${rows.length - copied}`);
  return copied;
}

async function copyJobEvents() {
  const count = sqlite.prepare(`SELECT COUNT(*) AS n FROM agent_job_events`).get().n;
  log(`agent_job_events: ${count} rows in sqlite`);
  if (count === 0) return 0;

  // Stream in chunks instead of .all() — job events can be big.
  let copied = 0;
  const stmt = sqlite.prepare(`SELECT * FROM agent_job_events ORDER BY id ASC LIMIT ? OFFSET ?`);
  let offset = 0;
  while (offset < count) {
    const rows = stmt.all(BATCH, offset);
    if (rows.length === 0) break;
    const values = [];
    const params = [];
    rows.forEach((r, idx) => {
      const off = idx * 7;
      values.push(`($${off+1},$${off+2},$${off+3},$${off+4},$${off+5},$${off+6}::jsonb,$${off+7}::timestamptz)`);
      params.push(r.id, r.job_id, r.seq, r.event_type, r.event_subtype, r.payload, toIso(r.created_at));
    });
    const sql = `
      INSERT INTO agent_job_events (id, job_id, seq, event_type, event_subtype, payload, created_at)
      VALUES ${values.join(',')}
      ON CONFLICT (job_id, seq) DO NOTHING`;
    const r = await pool.query(sql, params);
    copied += r.rowCount;
    offset += rows.length;
    if (offset % (BATCH * 10) === 0) log(`  …${offset}/${count}`);
  }
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('agent_job_events','id'),
                   GREATEST((SELECT COALESCE(MAX(id), 0) FROM agent_job_events), 1))`
  );
  log(`agent_job_events: inserted ${copied}, skipped ${count - copied}`);
  return copied;
}

async function copyMemoryWrites() {
  const rows = sqlite.prepare(`SELECT * FROM agent_memory_writes`).all();
  log(`agent_memory_writes: ${rows.length} rows in sqlite`);
  if (rows.length === 0) return 0;

  let copied = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = [];
    const params = [];
    chunk.forEach((r, idx) => {
      const off = idx * 2;
      values.push(`($${off+1},$${off+2})`);
      params.push(r.job_id, r.memory_id);
    });
    const sql = `
      INSERT INTO agent_memory_writes (job_id, memory_id)
      VALUES ${values.join(',')}
      ON CONFLICT (job_id, memory_id) DO NOTHING`;
    const r = await pool.query(sql, params);
    copied += r.rowCount;
  }
  log(`agent_memory_writes: inserted ${copied}, skipped ${rows.length - copied}`);
  return copied;
}

(async () => {
  try {
    await pool.query('SELECT 1'); // fast-fail if pg is unreachable
    log(`source: ${dbPath}`);
    log(`target: postgres://${process.env.PG_USER}@${process.env.PG_HOST}/${process.env.PG_DATABASE}`);

    const wi = await copyWorkflowInstances();
    const log_ = await copyJobLog();
    const ev = await copyJobEvents();
    const mw = await copyMemoryWrites();

    log(`DONE — wi:${wi} log:${log_} events:${ev} mem:${mw}`);
  } catch (err) {
    console.error('[backfill] FAILED', err);
    process.exit(1);
  } finally {
    await pool.end();
    sqlite.close();
  }
})();
