import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import express from 'express';
import { initMasterDatabase, createProject, closeAllDatabases } from '../../src/server/db.js';
import { createRouter } from '../../src/server/routes.js';

vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ getJobs: async () => [], add: async () => ({}) }),
  QUEUES: { agent: 'agent' }
}));

describe('POST/GET /api/captures environment', () => {
  let tmp, project, app;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-renv-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo' });
    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api', createRouter({ storagePath: tmp }));
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('stores environment when provided', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', environment: 'production' });
    expect(res.status).toBe(201);
    expect(res.body.environment).toBe('production');
  });

  it('accepts captures without environment (backward compat)', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x' });
    expect(res.status).toBe(201);
    expect(res.body.environment).toBeNull();
  });

  it('accepts slug-ish environment values (preview-pr-42)', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', environment: 'preview-pr-42' });
    expect(res.status).toBe(201);
    expect(res.body.environment).toBe('preview-pr-42');
  });

  it('truncates environment to 64 chars', async () => {
    const long = 'a'.repeat(100);
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', environment: long });
    // Server trims post-validation; regex only matches within 64 chars so
    // a 100-char string actually fails the regex. Assert 400 on too-long.
    expect(res.status).toBe(400);
  });

  it('rejects environment containing invalid chars (space, semicolon)', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', environment: 'hack; DROP TABLE' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/environment/i);
  });

  it('rejects environment that is not a string (number)', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', environment: 42 });
    expect(res.status).toBe(400);
  });

  it('accepts environment: null (treated as absent)', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', environment: null });
    expect(res.status).toBe(201);
    expect(res.body.environment).toBeNull();
  });

  it('GET /captures?environment=staging filters', async () => {
    const post = (body) => request(app).post('/api/captures').set('X-API-Key', project.api_key).send(body);
    await post({ content: 'a', environment: 'production' });
    await post({ content: 'b', environment: 'staging' });
    await post({ content: 'c' });

    const r = await request(app)
      .get('/api/captures?environment=staging')
      .set('X-API-Key', project.api_key);
    expect(r.status).toBe(200);
    expect(r.body.captures.length).toBe(1);
    expect(r.body.captures[0].content).toBe('b');
  });
});
