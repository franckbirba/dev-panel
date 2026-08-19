// Bench D: read-only admin route polled by scripts/bench/assert.mjs to
// assert scenario outcomes (engine-contract §11). workflow-instances is
// pg-backed — mocked here so the route test stays sqlite/tmp only, same
// footprint as routes-admin-projects-by-plane-id.test.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase } from '../../src/server/db.js';

vi.mock('../../src/server/workflow-instances.js', () => ({
  listByWorkItem: vi.fn(async (id) => (id === 'wi-known' ? [{
    id: 42,
    work_item_id: 'wi-known',
    workflow_name: 'work-item',
    status: 'completed',
    current_step: 'qa',
    last_event_at: '2026-08-19T00:00:00Z',
    last_job_id: '5100',
    internal_column_not_exposed: 'x'
  }] : []))
}));

describe('GET /api/admin/workflow-instances', () => {
  let app;

  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-awi-'));
    initMasterDatabase(tmp);
    process.env.ADMIN_API_KEY = 'admin_test_key';
    process.env.NODE_ENV = 'test';
    const { createRouter } = await import('../../src/server/routes.js');
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ storagePath: tmp }));
  });

  it('returns 401 without admin key', async () => {
    const r = await request(app).get('/api/admin/workflow-instances?work_item_id=wi-known');
    expect(r.status).toBe(401);
  });

  it('returns 400 without work_item_id', async () => {
    const r = await request(app)
      .get('/api/admin/workflow-instances')
      .set('X-Admin-Key', 'admin_test_key');
    expect(r.status).toBe(400);
  });

  it('returns the instance rows, whitelisted fields only', async () => {
    const r = await request(app)
      .get('/api/admin/workflow-instances?work_item_id=wi-known')
      .set('X-Admin-Key', 'admin_test_key');
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toEqual({
      id: 42,
      work_item_id: 'wi-known',
      workflow_name: 'work-item',
      status: 'completed',
      current_step: 'qa',
      last_event_at: '2026-08-19T00:00:00Z',
      last_job_id: '5100'
    });
  });

  it('returns [] for an unknown work item', async () => {
    const r = await request(app)
      .get('/api/admin/workflow-instances?work_item_id=wi-unknown')
      .set('X-Admin-Key', 'admin_test_key');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
});
