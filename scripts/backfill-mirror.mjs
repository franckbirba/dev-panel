#!/usr/bin/env node
// One-off: read the agents host's local master SQLite and POST every
// workflow_instances / agent_job_log / agent_job_events / agent_memory_writes
// row into the services API's mirror endpoints. Idempotent — duplicates are
// swallowed by the endpoints (unique-constraint catches).
//
// Run on hetzner-vps:
//   DEVPANEL_REMOTE_MASTER=https://devpanl.dev/api \
//   ADMIN_API_KEY=... \
//   node scripts/backfill-mirror.mjs

import { createRequire } from 'module';
import { resolve } from 'path';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const STORAGE = process.env.DEVPANEL_STORAGE || './storage';
const BASE = process.env.DEVPANEL_REMOTE_MASTER;
const KEY = process.env.ADMIN_API_KEY;
if (!BASE || !KEY) {
  console.error('set DEVPANEL_REMOTE_MASTER and ADMIN_API_KEY');
  process.exit(1);
}

const db = new Database(resolve(STORAGE, 'projects.db'), { readonly: true });

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// /admin/mirror/* routes bypass the global rate limiter (admin key required)
// but we still retry on the off chance of transient 429/5xx.
async function post(path, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': KEY },
      body: JSON.stringify(body)
    });
    if (r.ok) return true;
    if (r.status === 429 || r.status >= 500) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    const t = await r.text().catch(() => '');
    console.error(`${path} ${r.status}: ${t.slice(0, 200)}`);
    return false;
  }
  console.error(`${path} exhausted retries`);
  return false;
}

async function backfillWorkflowInstances() {
  const rows = db.prepare(`SELECT * FROM workflow_instances ORDER BY id ASC`).all();
  console.log(`workflow_instances: ${rows.length} rows`);
  let ok = 0;
  for (const r of rows) {
    // Seed the row via an update call — endpoint handles "missing" gracefully.
    const success = await post('/admin/mirror/workflow-instances/update', {
      work_item_id: r.work_item_id,
      workflow_name: r.workflow_name,
      revision: r.revision,
      current_step: r.current_step,
      status: r.status,
      last_event_at: r.last_event_at,
      exhausted_at: r.exhausted_at,
      last_job_id: r.last_job_id,
      metadata: r.metadata
    });
    if (success) ok++;
  }
  console.log(`  mirrored ${ok}/${rows.length}`);
}

async function backfillJobLog() {
  const rows = db.prepare(`SELECT * FROM agent_job_log ORDER BY id ASC`).all();
  console.log(`agent_job_log: ${rows.length} rows`);
  let ok = 0;
  for (const r of rows) {
    const success = await post('/admin/mirror/job-log', {
      job_id: r.job_id, agent: r.agent, step: r.step,
      status: r.status, error: r.error, duration_ms: r.duration_ms
    });
    if (success) ok++;
  }
  console.log(`  mirrored ${ok}/${rows.length}`);
}

async function backfillJobEvents() {
  const rows = db.prepare(`SELECT * FROM agent_job_events ORDER BY id ASC`).all();
  console.log(`agent_job_events: ${rows.length} rows`);
  let ok = 0;
  for (const r of rows) {
    const success = await post('/admin/mirror/job-events', {
      job_id: r.job_id, seq: r.seq, event_type: r.event_type,
      event_subtype: r.event_subtype, payload: r.payload
    });
    if (success) ok++;
  }
  console.log(`  mirrored ${ok}/${rows.length}`);
}

async function backfillMemoryWrites() {
  try {
    const rows = db.prepare(`SELECT * FROM agent_memory_writes`).all();
    console.log(`agent_memory_writes: ${rows.length} rows`);
    let ok = 0;
    for (const r of rows) {
      const success = await post('/admin/mirror/memory-write', {
        job_id: r.job_id, memory_id: r.memory_id
      });
      if (success) ok++;
    }
    console.log(`  mirrored ${ok}/${rows.length}`);
  } catch (e) {
    console.log(`  skipped: ${e.message}`);
  }
}

(async () => {
  await backfillWorkflowInstances();
  await backfillJobLog();
  await backfillJobEvents();
  await backfillMemoryWrites();
})();
