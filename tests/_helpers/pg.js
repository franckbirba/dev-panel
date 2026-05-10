// tests/_helpers/pg.js
// Spins a throwaway Postgres container, applies migrations 003-006 (orchestration
// tables, dev_bots, dev_bot_allowlist, team_members + team_routing), wires the shared pg pool to it, and returns cleanup helpers.
//
// Usage:
//   import { startPg, stopPg, truncateOrchestration, truncateTeam } from '../_helpers/pg.js';
//   beforeAll(async () => { await startPg(); });
//   afterAll(async () => { await stopPg(); });
//   beforeEach(() => truncateOrchestration());
//
// Requires: docker on PATH, migration files at infra/migrations/{003,004,005,006}-*.sql.
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  resolve(__dirname, '../../infra/migrations/003-orchestration-pg.sql'),
  resolve(__dirname, '../../infra/migrations/004-dev-bots.sql'),
  resolve(__dirname, '../../infra/migrations/005-dev-bot-allowlist.sql'),
  resolve(__dirname, '../../infra/migrations/006-team-routing.sql'),
  resolve(__dirname, '../../infra/migrations/010-job-inbox.sql'),
  resolve(__dirname, '../../infra/migrations/011-telegram-pending-replies.sql'),
];

let containerId = null;
let poolRef = null;

function docker(args, opts = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

async function waitReady(timeoutMs = 30000) {
  const start = Date.now();
  // pg_isready can report ready before the init scripts that create
  // POSTGRES_DB have finished. Probe with a real `SELECT 1` against the
  // target db to confirm end-to-end readiness.
  while (Date.now() - start < timeoutMs) {
    const r = spawnSync('docker', ['exec', containerId, 'psql', '-U', 'test', '-d', 'test', '-tAc', 'SELECT 1'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '1') return;
    await new Promise(res => setTimeout(res, 300));
  }
  throw new Error('pg container did not become ready in time');
}

export async function startPg() {
  if (containerId) return;
  // Pick a random host port so multiple runs don't collide. We bind to 127.0.0.1
  // so CI runners that expose docker publish-all don't accidentally expose pg.
  const port = 15000 + Math.floor(Math.random() * 40000);
  containerId = docker([
    'run', '-d', '--rm',
    '-p', `127.0.0.1:${port}:5432`,
    '-e', 'POSTGRES_USER=test',
    '-e', 'POSTGRES_PASSWORD=test',
    '-e', 'POSTGRES_DB=test',
    'postgres:16-alpine'
  ]);
  process.env.PG_HOST = '127.0.0.1';
  process.env.PG_PORT = String(port);
  process.env.PG_USER = 'test';
  process.env.PG_PASSWORD = 'test';
  process.env.PG_DATABASE = 'test';
  await waitReady();
  // Apply migrations 003, 004, 005, 006. We read each file and pipe via docker exec
  // so we don't need to bind-mount anything (keeps the helper portable across runners).
  for (const path of MIGRATIONS) {
    const sql = readFileSync(path, 'utf8');
    const r = spawnSync('docker', ['exec', '-i', containerId, 'psql', '-U', 'test', '-d', 'test', '-v', 'ON_ERROR_STOP=1'], {
      input: sql, encoding: 'utf8'
    });
    if (r.status !== 0) {
      throw new Error(`migration ${path} failed: ${r.stderr}`);
    }
  }
  // Reset the pg pool module so it re-reads the env. We import after setting
  // env because src/server/pg.js captures env at module-load time.
  const mod = await import('../../src/server/pg.js');
  poolRef = mod.pool;
}

export async function stopPg() {
  if (poolRef) {
    try { await poolRef.end(); } catch { /* ignore */ }
    poolRef = null;
  }
  if (containerId) {
    spawnSync('docker', ['kill', containerId], { stdio: 'ignore' });
    containerId = null;
  }
}

export async function truncateOrchestration() {
  if (!poolRef) throw new Error('startPg() must be called first');
  await poolRef.query(
    `TRUNCATE workflow_instances, agent_job_log, agent_job_events, agent_memory_writes, job_inbox, telegram_pending_replies RESTART IDENTITY`
  );
}

export async function truncateTeam() {
  if (!poolRef) throw new Error('startPg() must be called first');
  await poolRef.query(
    `TRUNCATE team_routing, team_members, dev_bot_allowlist, dev_bots RESTART IDENTITY CASCADE`
  );
}

export function getPool() {
  if (!poolRef) throw new Error('startPg() must be called first');
  return poolRef;
}
