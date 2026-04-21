import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject } from '../../src/server/db.js';
import { upsertSubject } from '../../src/server/subjects.js';
import { recordDeployEvent } from '../../src/server/deploy-events.js';

vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ getJobs: async () => [] }),
  QUEUES: { agent: 'agent' }
}));

describe('signal/thread/subject routes', () => {
  let app, project;
  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-routes-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
    const { createRouter } = await import('../../src/server/routes.js');
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ storagePath: tmp }));
  });

  it('GET /api/signals returns aggregated rows', async () => {
    recordDeployEvent({ project_id: project.id, status: 'failed', sha: 'abc', failed_reason: 'lint' });
    const r = await request(app).get('/api/signals')
      .set('X-API-Key', project.api_key);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.signals)).toBe(true);
    expect(r.body.signals.length).toBeGreaterThan(0);
  });

  it('GET /api/threads/:type/:id lazy-creates and returns messages', async () => {
    upsertSubject({ subject_type: 'work_item', subject_id: 'WI-1', project_id: project.id, title: 't' });
    const r = await request(app).get('/api/threads/work_item/WI-1')
      .set('X-API-Key', project.api_key);
    expect(r.status).toBe(200);
    expect(r.body.thread_id).toBeGreaterThan(0);
    expect(r.body.messages).toEqual([]);
  });

  it('POST /api/threads/:type/:id/messages appends a user message and posts to Telegram', async () => {
    upsertSubject({ subject_type: 'work_item', subject_id: 'WI-2', project_id: project.id, title: 't' });
    process.env.SHELLY_TELEGRAM_WEBHOOK = 'https://webhook.test/hook';
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const r = await request(app).post('/api/threads/work_item/WI-2/messages')
      .set('X-API-Key', project.api_key)
      .send({ content: 'hello shelly' });
    expect(r.status).toBe(200);
    expect(global.fetch).toHaveBeenCalled();
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.text).toMatch(/^\[thread:work_item\/WI-2\] hello shelly/);
  });

  it('PATCH /api/subjects/:type/:id updates priority', async () => {
    upsertSubject({ subject_type: 'capture', subject_id: 'cap-1', project_id: project.id, title: 't' });
    const r = await request(app).patch('/api/subjects/capture/cap-1')
      .set('X-API-Key', project.api_key)
      .send({ priority: 'now' });
    expect(r.status).toBe(200);
    expect(r.body.priority).toBe('now');
  });

  it('PATCH /api/subjects rejects invalid priority', async () => {
    upsertSubject({ subject_type: 'capture', subject_id: 'cap-2', project_id: project.id, title: 't' });
    const r = await request(app).patch('/api/subjects/capture/cap-2')
      .set('X-API-Key', project.api_key)
      .send({ priority: 'urgent' });
    expect(r.status).toBe(400);
  });
});
