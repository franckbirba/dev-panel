// DEVPA-180: route used by the dispatcher on the agents host to look up the
// local checkout config without trusting its own (empty) SQLite.
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject, updateProject } from '../../src/server/db.js';

describe('GET /api/admin/projects/by-plane-id/:plane_project_id', () => {
  let app, adminKey, project;

  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-bpi-'));
    initMasterDatabase(tmp);
    adminKey = 'admin_test_key';
    process.env.ADMIN_API_KEY = adminKey;
    process.env.NODE_ENV = 'test';

    project = createProject({
      name: 'Zeno',
      github_owner: 'EpitechAfrik',
      github_repo: 'Zeno'
    });
    updateProject(project.id, {
      plane_project_id: '80f082d2-bbf7-4c7a-9e4c-a1e3f76ffa52',
      plane_workspace_slug: 'devpanl',
      local_path: '/home/deploy/projects/Zeno',
      default_branch: 'main'
    });

    const { createRouter } = await import('../../src/server/routes.js');
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ storagePath: tmp }));
  });

  it('returns 401 without admin key', async () => {
    const r = await request(app).get('/api/admin/projects/by-plane-id/80f082d2-bbf7-4c7a-9e4c-a1e3f76ffa52');
    expect(r.status).toBe(401);
  });

  it('returns 200 + project config for a linked plane_project_id', async () => {
    const r = await request(app)
      .get('/api/admin/projects/by-plane-id/80f082d2-bbf7-4c7a-9e4c-a1e3f76ffa52')
      .set('X-Admin-Key', adminKey);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      name: 'Zeno',
      plane_project_id: '80f082d2-bbf7-4c7a-9e4c-a1e3f76ffa52',
      local_path: '/home/deploy/projects/Zeno',
      default_branch: 'main'
    });
    // api_key MUST NOT leak — this is a routing-config endpoint.
    expect(r.body.api_key).toBeUndefined();
  });

  it('returns 404 for an unknown plane_project_id', async () => {
    const r = await request(app)
      .get('/api/admin/projects/by-plane-id/00000000-0000-0000-0000-000000000000')
      .set('X-Admin-Key', adminKey);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('project_not_linked');
  });
});
