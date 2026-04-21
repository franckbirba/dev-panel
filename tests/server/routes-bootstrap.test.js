import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase } from '../../src/server/db.js';

vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ add: vi.fn().mockResolvedValue({ id: 'job_x' }), getJobs: async () => [] }),
  QUEUES: { agent: 'agent' }
}));

describe('POST /api/projects/from-github', () => {
  let app, adminKey;
  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-pb-'));
    initMasterDatabase(tmp);
    adminKey = 'admin_test_key';
    process.env.ADMIN_API_KEY = adminKey;
    process.env.PLANE_API_BASE = 'https://plane.test';
    process.env.PLANE_WORKSPACE_SLUG = 'devpanl';
    process.env.PLANE_API_TOKEN = 'plane_tok';
    process.env.GITHUB_TOKEN = 'gh_tok';
    global.fetch = vi.fn(async (url) => {
      if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => ({ name: 'newproj', default_branch: 'main' }) };
      if (url.includes('plane.test')) return { ok: true, status: 201, json: async () => ({ id: 'plane-x' }) };
    });
    const { createRouter } = await import('../../src/server/routes.js');
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ storagePath: tmp }));
  });

  it('requires admin key', async () => {
    const r = await request(app).post('/api/projects/from-github').send({ github_url: 'a/b' });
    expect(r.status).toBe(401);
  });

  it('happy path: returns project + bootstrap_job_id', async () => {
    const r = await request(app).post('/api/projects/from-github')
      .set('X-Admin-Key', adminKey)
      .send({ github_url: 'https://github.com/me/newproj' });
    expect(r.status).toBe(201);
    expect(r.body.project.name).toBe('newproj');
    expect(r.body.bootstrap_job_id).toBe('job_x');
  });

  it('returns 400 on garbage URL', async () => {
    const r = await request(app).post('/api/projects/from-github')
      .set('X-Admin-Key', adminKey)
      .send({ github_url: 'not a url' });
    expect(r.status).toBe(400);
  });
});
