import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject, getMasterDatabase } from '../../src/server/db.js';
import { recordDeployEvent } from '../../src/server/deploy-events.js';
import { createCapture } from '../../src/server/captures.js';

// BullMQ stubbed — failed jobs path is exercised via Redis in production but
// here we just verify the route shape and the deploy + capture sources.
vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ getJobs: async () => [] }),
  QUEUES: { agent: 'agent' }
}));

describe('GET /api/inbox', () => {
  let app, project;

  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-inbox-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
    const { createRouter } = await import('../../src/server/routes.js');
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ storagePath: tmp }));
  });

  it('returns an empty inbox when nothing has been signalled', async () => {
    const r = await request(app).get('/api/inbox').set('X-API-Key', project.api_key);
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect(r.body.counts).toEqual({ total: 0, REVIEW: 0, QUESTION: 0, NOTIFY: 0 });
  });

  it('surfaces a new capture as a QUESTION and a deploy failure as a NOTIFY', async () => {
    recordDeployEvent({
      project_id: project.id, status: 'failed', sha: 'abc123',
      failed_reason: 'lint failed'
    });
    createCapture({
      project_id: project.id,
      content: 'pagination is broken on the dashboard',
      kind: 'idea',
    });

    const r = await request(app).get('/api/inbox').set('X-API-Key', project.api_key);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBe(2);
    const types = r.body.items.map(i => i.type).sort();
    expect(types).toEqual(['NOTIFY', 'QUESTION']);
    expect(r.body.counts.QUESTION).toBe(1);
    expect(r.body.counts.NOTIFY).toBe(1);

    // Capture row carries the right metadata
    const cap = r.body.items.find(i => i.type === 'QUESTION');
    expect(cap.subject_type).toBe('capture');
    expect(cap.origin).toBe('capture');
    expect(cap.title).toMatch(/pagination/);
    expect(cap.project_name).toBe('demo');

    // Deploy row carries the right metadata
    const deploy = r.body.items.find(i => i.type === 'NOTIFY');
    expect(deploy.subject_type).toBe('deploy');
    expect(deploy.origin).toBe('deploy');
    expect(deploy.signal_type).toBe('deploy_failed');
  });

  it('filters by type when ?type=QUESTION is passed', async () => {
    recordDeployEvent({ project_id: project.id, status: 'failed', sha: 'aaa' });
    createCapture({ project_id: project.id, content: 'idea', kind: 'idea' });

    const r = await request(app)
      .get('/api/inbox?type=QUESTION')
      .set('X-API-Key', project.api_key);
    expect(r.status).toBe(200);
    expect(r.body.items.every(i => i.type === 'QUESTION')).toBe(true);
    expect(r.body.items.length).toBe(1);
  });

  it('hides a row that has been dismissed', async () => {
    const cap = createCapture({ project_id: project.id, content: 'duplicate of ZENO-38', kind: 'idea' });
    // Dismiss the capture via the route
    const dismiss = await request(app)
      .post(`/api/inbox/capture/${cap.id}/dismiss`)
      .set('X-API-Key', project.api_key)
      .send({});
    expect(dismiss.status).toBe(200);
    expect(dismiss.body.ok).toBe(true);

    const r = await request(app).get('/api/inbox').set('X-API-Key', project.api_key);
    expect(r.body.items).toEqual([]);
  });

  it('hides a row while snoozed and brings it back after restore', async () => {
    const cap = createCapture({ project_id: project.id, content: 'snooze me', kind: 'idea' });

    // Snooze
    const sn = await request(app)
      .post(`/api/inbox/capture/${cap.id}/snooze`)
      .set('X-API-Key', project.api_key)
      .send({ minutes: 60 });
    expect(sn.status).toBe(200);
    expect(sn.body.snoozed_until).toBeTruthy();

    let r = await request(app).get('/api/inbox').set('X-API-Key', project.api_key);
    expect(r.body.items).toEqual([]);

    // Restore
    const rs = await request(app)
      .post(`/api/inbox/capture/${cap.id}/restore`)
      .set('X-API-Key', project.api_key)
      .send({});
    expect(rs.status).toBe(200);

    r = await request(app).get('/api/inbox').set('X-API-Key', project.api_key);
    expect(r.body.items.length).toBe(1);
  });

  it('rejects unauthenticated requests', async () => {
    const r = await request(app).get('/api/inbox');
    expect(r.status).toBe(401);
  });

  it('keeps untriaged captures visible past the since_min window', async () => {
    const cap = createCapture({ project_id: project.id, content: 'old but unanswered', kind: 'idea' });
    getMasterDatabase().prepare(
      `UPDATE captures SET created_at = ? WHERE id = ?`
    ).run('2026-01-01 00:00:00', cap.id);

    const r = await request(app)
      .get('/api/inbox?since_min=60')
      .set('X-API-Key', project.api_key);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBe(1);
    expect(r.body.items[0].subject_id).toBe(cap.id);
  });
});
