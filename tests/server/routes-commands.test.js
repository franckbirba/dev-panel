import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('routes-commands', () => {
  let app, storage, projectKey;
  let createRouter, initMasterDatabase, createProject;
  const adminKey = 'test-admin-key-cmd';

  beforeAll(async () => {
    process.env.ADMIN_API_KEY = adminKey;
    // Dynamic imports so env is read fresh.
    ({ createRouter } = await import('../../src/server/routes.js'));
    ({ initMasterDatabase, createProject } = await import('../../src/server/db.js'));
  });
  afterAll(() => { delete process.env.ADMIN_API_KEY; });

  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), 'devpanel-routes-cmd-'));
    initMasterDatabase(storage);
    const project = createProject({ name: 'cmdtest', github_owner: 'o', github_repo: 'r' });
    projectKey = project.api_key;
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ storagePath: storage }));
  });

  // ── Auth & routing ──

  it('404 for unknown command', async () => {
    const r = await supertest(app)
      .post('/api/commands/nonexistent')
      .set('X-Admin-Key', adminKey);
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/Unknown command/);
  });

  it('401 with no auth', async () => {
    const r = await supertest(app)
      .post('/api/commands/dispatch')
      .send({ work_item_id: 'DEVPA-1' });
    expect(r.status).toBe(401);
  });

  it('403 for admin-only command with project auth', async () => {
    const r = await supertest(app)
      .post('/api/commands/dispatch')
      .set('X-API-Key', projectKey)
      .send({ work_item_id: 'DEVPA-1' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Admin access required/);
  });

  it('403 for promote-capture with project auth', async () => {
    const r = await supertest(app)
      .post('/api/commands/promote-capture')
      .set('X-API-Key', projectKey)
      .send({ capture_id: 1 });
    expect(r.status).toBe(403);
  });

  // ── Param validation ──

  it('400 when dispatch missing work_item_id', async () => {
    const r = await supertest(app)
      .post('/api/commands/dispatch')
      .set('X-Admin-Key', adminKey)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/work_item_id/);
  });

  it('400 when cancel-job missing job_id', async () => {
    const r = await supertest(app)
      .post('/api/commands/cancel-job')
      .set('X-Admin-Key', adminKey)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/job_id/);
  });

  it('400 when escalate missing message', async () => {
    const r = await supertest(app)
      .post('/api/commands/escalate')
      .set('X-API-Key', projectKey)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/message/);
  });

  // ── Successful commands (no external deps) ──

  it('snooze returns ok with admin auth', async () => {
    const r = await supertest(app)
      .post('/api/commands/snooze')
      .set('X-Admin-Key', adminKey)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.until).toBeDefined();
  });

  it('escalate returns ok with project auth', async () => {
    const r = await supertest(app)
      .post('/api/commands/escalate')
      .set('X-API-Key', projectKey)
      .send({ message: 'Need help with deploy' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.text).toBe('Need help with deploy');
  });

  it('new-capture creates a capture with project auth', async () => {
    const r = await supertest(app)
      .post('/api/commands/new-capture')
      .set('X-API-Key', projectKey)
      .send({ content: 'Button misaligned on mobile' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.capture_id).toBeDefined();
  });

  it('new-capture 400 without content', async () => {
    const r = await supertest(app)
      .post('/api/commands/new-capture')
      .set('X-API-Key', projectKey)
      .send({});
    expect(r.status).toBe(400);
  });

  it('admin can also use project-scoped commands', async () => {
    // Admin + project key = both levels
    const r = await supertest(app)
      .post('/api/commands/new-capture')
      .set('X-Admin-Key', adminKey)
      .set('X-API-Key', projectKey)
      .send({ content: 'Admin-created capture' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});
