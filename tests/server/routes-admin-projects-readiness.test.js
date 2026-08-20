// ADR-003 §2 — GET /api/admin/projects/:id/readiness. Same admin-key gate
// and sqlite-only test footprint as routes-admin-projects-by-plane-id.test.js.
// The worker call (A1-A3) is exercised via a mocked global.fetch — no real
// worker process needed for the route contract itself (src/server/readiness.js
// already has its own unit coverage for the degrade-to-warn behavior).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject, updateProject } from '../../src/server/db.js';

describe('GET /api/admin/projects/:id/readiness', () => {
  let app, adminKey, project;
  const ORIGINAL_FETCH = global.fetch;

  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-readiness-'));
    initMasterDatabase(tmp);
    adminKey = 'admin_test_key';
    process.env.ADMIN_API_KEY = adminKey;
    process.env.NODE_ENV = 'test';
    process.env.WORKER_API_URL = 'http://worker.test:3099';

    project = createProject({
      name: 'Zeno',
      github_owner: 'EpitechAfrik',
      github_repo: 'Zeno'
    });
    updateProject(project.id, {
      plane_project_id: '80f082d2-bbf7-4c7a-9e4c-a1e3f76ffa52',
      local_path: '/home/deploy/projects/Zeno',
      default_branch: 'main'
    });

    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      checks: [
        { id: 'A1', status: 'pass', detail: 'clone exists' },
        { id: 'A2', status: 'pass', detail: 'fetched 1h ago' },
        { id: 'A3', status: 'pass', detail: 'ssh remote' }
      ]
    }), { status: 200 }));

    const { createRouter } = await import('../../src/server/routes.js');
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ storagePath: tmp }));
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  it('returns 401 without admin key', async () => {
    const r = await request(app).get(`/api/admin/projects/${project.id}/readiness`);
    expect(r.status).toBe(401);
  });

  it('returns 404 for an unknown project id', async () => {
    const r = await request(app)
      .get('/api/admin/projects/00000000-0000-0000-0000-000000000000/readiness')
      .set('X-Admin-Key', adminKey);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('project_not_found');
  });

  it('returns ready:true with all checks passing for a fully-linked project', async () => {
    const r = await request(app)
      .get(`/api/admin/projects/${project.id}/readiness`)
      .set('X-Admin-Key', adminKey);
    expect(r.status).toBe(200);
    expect(r.body.ready).toBe(true);
    expect(r.body.checks.map(c => c.id)).toEqual(
      expect.arrayContaining(['S1', 'S2', 'S3', 'S4', 'S5', 'A1', 'A2', 'A3'])
    );
    expect(r.body.checks.every(c => c.status === 'pass')).toBe(true);
  });

  it('returns ready:false and fail S2 when plane_project_id is missing', async () => {
    updateProject(project.id, { plane_project_id: null });
    const r = await request(app)
      .get(`/api/admin/projects/${project.id}/readiness`)
      .set('X-Admin-Key', adminKey);
    expect(r.status).toBe(200);
    expect(r.body.ready).toBe(false);
    expect(r.body.checks.find(c => c.id === 'S2').status).toBe('fail');
  });

  it('degrades A1-A3 to warn (not a false pass) when the worker is unreachable', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const r = await request(app)
      .get(`/api/admin/projects/${project.id}/readiness`)
      .set('X-Admin-Key', adminKey);
    expect(r.status).toBe(200);
    const agentChecks = r.body.checks.filter(c => ['A1', 'A2', 'A3'].includes(c.id));
    for (const c of agentChecks) {
      expect(c.status).toBe('warn');
      expect(c.detail).toMatch(/agents host non v[ée]rifiable/i);
    }
    // Services side is fully green and A* only warns → still "ready" per
    // the readiness module contract (warn never flips ready to false).
    expect(r.body.ready).toBe(true);
  });
});
