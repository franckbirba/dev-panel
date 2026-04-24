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

describe('POST/GET /api/captures reporter', () => {
  let tmp, project, app;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-rrep-'));
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

  it('stores reporter when provided', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', reporter: { id: 'u_1', name: 'Alice', email: 'a@x' } });
    expect(res.status).toBe(201);
    expect(res.body.reporter_id).toBe('u_1');

    const list = await request(app).get('/api/captures').set('X-API-Key', project.api_key);
    expect(list.body.captures[0].reporter_id).toBe('u_1');
  });

  it('accepts captures without reporter (backward compat)', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x' });
    expect(res.status).toBe(201);
    expect(res.body.reporter_id).toBeNull();
  });

  it('rejects reporter that is not an object (string)', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', reporter: 'alice' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reporter/i);
  });

  it('rejects reporter that is an array', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', reporter: ['a', 'b'] });
    expect(res.status).toBe(400);
  });

  it('GET /captures?reporter_id=u_1 filters', async () => {
    const post = (body) => request(app).post('/api/captures').set('X-API-Key', project.api_key).send(body);
    await post({ content: 'a', reporter: { id: 'u_1', name: 'A' } });
    await post({ content: 'b', reporter: { id: 'u_2', name: 'B' } });
    await post({ content: 'c' });

    const r = await request(app)
      .get('/api/captures?reporter_id=u_1')
      .set('X-API-Key', project.api_key);
    expect(r.status).toBe(200);
    expect(r.body.captures.length).toBe(1);
    expect(r.body.captures[0].content).toBe('a');
  });
});
