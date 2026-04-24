// src/server/jobs-log.js
import { getMasterDatabase } from './db.js';
import { mirror } from './master-mirror.js';

export function logStep({ job_id, agent, step, status, error = null, duration_ms = null }) {
  const db = getMasterDatabase();
  db.prepare(
    `INSERT INTO agent_job_log (job_id, agent, step, status, error, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(job_id, agent, step, status, error, duration_ms);
  mirror('/admin/mirror/job-log', {
    job_id, agent, step, status, error, duration_ms
  });
}

export function listSteps(job_id) {
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT * FROM agent_job_log WHERE job_id = ? ORDER BY id ASC`
  ).all(job_id);
}

export function recordMemoryWrite(job_id, memory_id) {
  const db = getMasterDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO agent_memory_writes (job_id, memory_id) VALUES (?, ?)`
  ).run(job_id, memory_id);
  mirror('/admin/mirror/memory-write', { job_id, memory_id });
}

export function countMemoryWrites(job_id) {
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT COUNT(*) AS n FROM agent_memory_writes WHERE job_id = ?`
  ).get(job_id).n;
}
