import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import { initMasterDatabase, createProject, getMasterDatabase } from '../../src/server/db.js';
import { createRouter } from '../../src/server/routes.js';

// These tests hit the /admin/mirror/* endpoints directly and verify they
// replicate into the master SQLite. They do NOT exercise the worker-side
// mirror() helper (which is a fire-and-forget POST gated on env).
describe('admin mirror endpoints', () => {
  let server, base, adminKey;

  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-mirror-'));
    initMasterDatabase(tmp);
    createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
    adminKey = 'test-admin-key';
    process.env.ADMIN_API_KEY = adminKey;
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api', createRouter({ storagePath: tmp }));
    server = await new Promise(r => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise(r => server.close(r));
  });

  async function post(path, body) {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify(body)
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }

  it('creates a workflow_instance row on mirror/create', async () => {
    const now = Date.now();
    const r = await post('/api/admin/mirror/workflow-instances/create', {
      work_item_id: 'wi-1', workflow_name: 'work-item', current_step: 'builder',
      started_at: now, last_event_at: now
    });
    expect(r.status).toBe(200);
    expect(r.json.id).toBeTruthy();
    const db = getMasterDatabase();
    const row = db.prepare(`SELECT * FROM workflow_instances WHERE id=?`).get(r.json.id);
    expect(row.work_item_id).toBe('wi-1');
    expect(row.status).toBe('running');
  });

  it('update endpoint creates a row if none exists (out-of-order mirror)', async () => {
    const r = await post('/api/admin/mirror/workflow-instances/update', {
      work_item_id: 'wi-late', workflow_name: 'work-item',
      revision: 1, current_step: 'reviewer', status: 'done',
      last_event_at: Date.now()
    });
    expect(r.status).toBe(200);
    expect(r.json.created).toBe(true);
    const db = getMasterDatabase();
    const row = db.prepare(
      `SELECT * FROM workflow_instances WHERE work_item_id=? AND workflow_name=?`
    ).get('wi-late', 'work-item');
    expect(row.status).toBe('done');
  });

  it('job-events endpoint dedupes on (job_id, seq)', async () => {
    const body = { job_id: 'job-7', seq: 1, event_type: 'tool_use', payload: '{"x":1}' };
    const a = await post('/api/admin/mirror/job-events', body);
    const b = await post('/api/admin/mirror/job-events', body);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200); // silent dedup
    const db = getMasterDatabase();
    const rows = db.prepare(`SELECT COUNT(*) n FROM agent_job_events WHERE job_id=?`).get('job-7');
    expect(rows.n).toBe(1);
  });

  it('job-log endpoint appends rows', async () => {
    await post('/api/admin/mirror/job-log', {
      job_id: 'job-8', agent: 'builder', step: 'start', status: 'ok', duration_ms: 42
    });
    const db = getMasterDatabase();
    const row = db.prepare(`SELECT * FROM agent_job_log WHERE job_id=?`).get('job-8');
    expect(row.agent).toBe('builder');
    expect(row.duration_ms).toBe(42);
  });

  it('rejects calls without admin key', async () => {
    const r = await fetch(`${base}/api/admin/mirror/job-log`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: 'x', agent: 'a', step: 's', status: 'ok' })
    });
    expect(r.status).toBe(401);
  });
});
