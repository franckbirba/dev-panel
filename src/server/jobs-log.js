// src/server/jobs-log.js
// Orchestration job log + memory-write tracking. Dual-path behind
// DEVPANEL_PG_ORCHESTRATION: when truthy, writes hit the shared Postgres
// (agent_memory db, migration 003); otherwise stays on per-host SQLite +
// master-mirror bridge. All exports are async so callers pay the await
// cost regardless of path — that lets us flip modes at runtime without
// touching call sites.
import { getMasterDatabase } from './db.js';
import { mirror } from './master-mirror.js';
import { pool } from './pg.js';

function pgEnabled() {
  const v = process.env.DEVPANEL_PG_ORCHESTRATION;
  return v === '1' || v === 'true';
}

export async function logStep({ job_id, agent, step, status, error = null, duration_ms = null }) {
  if (pgEnabled()) {
    await pool.query(
      `INSERT INTO agent_job_log (job_id, agent, step, status, error, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [job_id, agent, step, status, error, duration_ms]
    );
    return;
  }
  const db = getMasterDatabase();
  db.prepare(
    `INSERT INTO agent_job_log (job_id, agent, step, status, error, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(job_id, agent, step, status, error, duration_ms);
  mirror('/admin/mirror/job-log', { job_id, agent, step, status, error, duration_ms });
}

export async function listSteps(job_id) {
  if (pgEnabled()) {
    const { rows } = await pool.query(
      `SELECT id, job_id, agent, step, status, error, duration_ms, timestamp
         FROM agent_job_log WHERE job_id = $1 ORDER BY id ASC`,
      [job_id]
    );
    return rows;
  }
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT * FROM agent_job_log WHERE job_id = ? ORDER BY id ASC`
  ).all(job_id);
}

export async function recordMemoryWrite(job_id, memory_id) {
  if (pgEnabled()) {
    await pool.query(
      `INSERT INTO agent_memory_writes (job_id, memory_id)
       VALUES ($1, $2)
       ON CONFLICT (job_id, memory_id) DO NOTHING`,
      [job_id, memory_id]
    );
    return;
  }
  const db = getMasterDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO agent_memory_writes (job_id, memory_id) VALUES (?, ?)`
  ).run(job_id, memory_id);
  mirror('/admin/mirror/memory-write', { job_id, memory_id });
}

export async function countMemoryWrites(job_id) {
  if (pgEnabled()) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM agent_memory_writes WHERE job_id = $1`,
      [job_id]
    );
    return rows[0].n;
  }
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT COUNT(*) AS n FROM agent_memory_writes WHERE job_id = ?`
  ).get(job_id).n;
}
