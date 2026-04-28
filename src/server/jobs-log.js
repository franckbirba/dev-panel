// src/server/jobs-log.js
// Orchestration job log + memory-write tracking on shared Postgres.
// Shared between services API and agents-host worker (same pg, migration 003).
import { pool } from './pg.js';

// Lazy SSE broadcast so this module stays loadable from worker context.
let _broadcast = null;
async function broadcast(event, data) {
  try {
    if (!_broadcast) {
      const m = await import('./sse.js');
      _broadcast = m.broadcast;
    }
    _broadcast(event, data);
  } catch { /* sse unavailable — degrade silently */ }
}

export async function logStep({ job_id, agent, step, status, error = null, duration_ms = null }) {
  await pool.query(
    `INSERT INTO agent_job_log (job_id, agent, step, status, error, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [job_id, agent, step, status, error, duration_ms]
  );
  // Real-time push so Fleet / Agents views update without polling.
  broadcast('agent_step', { job_id, agent, step, status, error, duration_ms });
}

export async function listSteps(job_id) {
  const { rows } = await pool.query(
    `SELECT id, job_id, agent, step, status, error, duration_ms, timestamp
       FROM agent_job_log WHERE job_id = $1 ORDER BY id ASC`,
    [job_id]
  );
  return rows;
}

export async function recordMemoryWrite(job_id, memory_id) {
  await pool.query(
    `INSERT INTO agent_memory_writes (job_id, memory_id)
     VALUES ($1, $2)
     ON CONFLICT (job_id, memory_id) DO NOTHING`,
    [job_id, memory_id]
  );
}

export async function countMemoryWrites(job_id) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM agent_memory_writes WHERE job_id = $1`,
    [job_id]
  );
  return rows[0].n;
}
