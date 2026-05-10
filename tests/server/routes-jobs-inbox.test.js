// tests/server/routes-jobs-inbox.test.js
// HTTP coverage for /api/jobs/:job_id/inbox/* — the surface dashboard +
// Telegram + the agent's MCP tool all share. Asserts auth (project key OR
// admin key), the question→reply round-trip, idempotency on duplicate
// callback_query_id, the long-poll 204 path, cancellation.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateOrchestration, truncateTeam } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('routes-jobs-inbox', () => {
  let app, projectKey, adminKey;
  let createRouter, initMasterDatabase, createProject;

  beforeAll(async () => {
    await startPg();
    adminKey = 'test-admin-key';
    process.env.ADMIN_API_KEY = adminKey;
    ({ createRouter } = await import('../../src/server/routes.js'));
    ({ initMasterDatabase, createProject } = await import('../../src/server/db.js'));
  }, 60000);

  afterAll(async () => {
    await stopPg();
  });

  beforeEach(async () => {
    await truncateOrchestration();
    await truncateTeam();
    const storage = mkdtempSync(join(tmpdir(), 'devpanel-routes-inbox-'));
    initMasterDatabase(storage);
    const project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
    projectKey = project.api_key;
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ storagePath: storage }));
  });

  it('rejects unauthenticated requests', async () => {
    const r = await supertest(app)
      .post('/api/jobs/job-1/inbox/question')
      .send({ kind: 'clarification', content: { prompt: 'q' } });
    expect(r.status).toBe(401);
  });

  it('accepts project key auth (dashboard path)', async () => {
    const r = await supertest(app)
      .post('/api/jobs/job-1/inbox/question')
      .set('X-API-Key', projectKey)
      .send({ kind: 'clarification', content: { prompt: 'q' } });
    expect(r.status).toBe(201);
    expect(r.body.question.role).toBe('agent_question');
  });

  it('accepts admin key auth (agent MCP path)', async () => {
    const r = await supertest(app)
      .post('/api/jobs/job-1/inbox/question')
      .set('X-Admin-Key', adminKey)
      .send({ kind: 'clarification', content: { prompt: 'q' } });
    expect(r.status).toBe(201);
  });

  it('round-trips question → reply via the dashboard', async () => {
    const q = await supertest(app)
      .post('/api/jobs/j/inbox/question')
      .set('X-Admin-Key', adminKey)
      .send({ kind: 'clarification', content: { prompt: 'which?', options: ['A', 'B'] } });
    expect(q.status).toBe(201);

    const r = await supertest(app)
      .post('/api/jobs/j/inbox/reply')
      .set('X-API-Key', projectKey)
      .send({ answer: 'A', source: 'dashboard' });
    expect(r.status).toBe(200);
    expect(r.body.consumed_question_seq).toBe(1);
    expect(r.body.reply_seq).toBe(2);
  });

  it('long-poll returns 204 when nothing has arrived', async () => {
    await supertest(app)
      .post('/api/jobs/j/inbox/question')
      .set('X-Admin-Key', adminKey)
      .send({ kind: 'clarification', content: { prompt: 'q' } });

    const poll = await supertest(app)
      .get('/api/jobs/j/inbox?after_seq=1')
      .set('X-Admin-Key', adminKey);
    expect(poll.status).toBe(204);
  });

  it('long-poll returns 200 with the reply once written', async () => {
    await supertest(app)
      .post('/api/jobs/j/inbox/question')
      .set('X-Admin-Key', adminKey)
      .send({ kind: 'clarification', content: { prompt: 'q' } });
    await supertest(app)
      .post('/api/jobs/j/inbox/reply')
      .set('X-API-Key', projectKey)
      .send({ answer: 'go' });

    const poll = await supertest(app)
      .get('/api/jobs/j/inbox?after_seq=1')
      .set('X-Admin-Key', adminKey);
    expect(poll.status).toBe(200);
    expect(poll.body.reply.role).toBe('human_reply');
    expect(poll.body.reply.content.answer).toBe('go');
  });

  it('replies with same callback_query_id are idempotent', async () => {
    await supertest(app)
      .post('/api/jobs/j/inbox/question')
      .set('X-Admin-Key', adminKey)
      .send({ kind: 'tool_approval', content: { tool: 'Bash', args: { command: 'rm -rf /' } } });

    const r1 = await supertest(app)
      .post('/api/jobs/j/inbox/reply')
      .set('X-API-Key', projectKey)
      .send({ answer: 'deny', callback_query_id: 'tg-cb-99' });
    expect(r1.status).toBe(200);
    expect(r1.body.duplicate).toBeFalsy();

    const r2 = await supertest(app)
      .post('/api/jobs/j/inbox/reply')
      .set('X-API-Key', projectKey)
      .send({ answer: 'deny', callback_query_id: 'tg-cb-99' });
    expect(r2.status).toBe(200);
    expect(r2.body.duplicate).toBe(true);

    const hist = await supertest(app)
      .get('/api/jobs/j/inbox/history')
      .set('X-API-Key', projectKey);
    expect(hist.body.messages.filter(m => m.role === 'human_reply')).toHaveLength(1);
  });

  it('returns 409 if no pending question (race)', async () => {
    const r = await supertest(app)
      .post('/api/jobs/orphan/inbox/reply')
      .set('X-API-Key', projectKey)
      .send({ answer: 'hi' });
    expect(r.status).toBe(409);
  });

  it('rejects invalid kind on question', async () => {
    const r = await supertest(app)
      .post('/api/jobs/j/inbox/question')
      .set('X-Admin-Key', adminKey)
      .send({ kind: 'bogus', content: {} });
    expect(r.status).toBe(400);
  });

  it('rejects empty answer on reply', async () => {
    await supertest(app)
      .post('/api/jobs/j/inbox/question')
      .set('X-Admin-Key', adminKey)
      .send({ kind: 'clarification', content: { prompt: 'q' } });
    const r = await supertest(app)
      .post('/api/jobs/j/inbox/reply')
      .set('X-API-Key', projectKey)
      .send({ answer: '   ' });
    expect(r.status).toBe(400);
  });

  it('cancel marks pending questions as cancelled', async () => {
    await supertest(app)
      .post('/api/jobs/j/inbox/question')
      .set('X-Admin-Key', adminKey)
      .send({ kind: 'clarification', content: { prompt: 'q' } });
    const c = await supertest(app)
      .post('/api/jobs/j/inbox/cancel')
      .set('X-API-Key', projectKey);
    expect(c.status).toBe(200);
    expect(c.body.cancelled_count).toBe(1);
    // Subsequent reply should now 409 — no pending question.
    const r = await supertest(app)
      .post('/api/jobs/j/inbox/reply')
      .set('X-API-Key', projectKey)
      .send({ answer: 'too late' });
    expect(r.status).toBe(409);
  });

  it('history returns messages in seq order', async () => {
    await supertest(app)
      .post('/api/jobs/j/inbox/question')
      .set('X-Admin-Key', adminKey)
      .send({ kind: 'clarification', content: { prompt: 'q1' } });
    await supertest(app)
      .post('/api/jobs/j/inbox/reply')
      .set('X-API-Key', projectKey)
      .send({ answer: 'a1' });
    await supertest(app)
      .post('/api/jobs/j/inbox/question')
      .set('X-Admin-Key', adminKey)
      .send({ kind: 'clarification', content: { prompt: 'q2' } });

    const h = await supertest(app)
      .get('/api/jobs/j/inbox/history')
      .set('X-API-Key', projectKey);
    expect(h.status).toBe(200);
    expect(h.body.messages.map(m => m.seq)).toEqual([1, 2, 3]);
    expect(h.body.messages.map(m => m.role)).toEqual([
      'agent_question', 'human_reply', 'agent_question',
    ]);
  });
});
