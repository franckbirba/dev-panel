import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'http';
import express from 'express';
import request from 'supertest';
import { initMasterDatabase, createProject, getMasterDatabase, closeAllDatabases } from '../../src/server/db.js';
import { createRouter } from '../../src/server/routes.js';
import { _setInboundQueueForTests } from '../../src/server/widget-bridge.js';
import { _resetWidgetSseForTests, publishToWidgetSession } from '../../src/server/widget-sse.js';

vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ getJobs: async () => [], add: async () => ({}) }),
  QUEUES: { agent: 'agent' },
  getAllQueuesHealth: async () => ({ status: 'ok', queues: [] }),
  resolveQueueName: () => null
}));

describe('widget API routes', () => {
  let tmp, project, app, captured;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-rwidget-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo' });
    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api', createRouter({ storagePath: tmp }));

    captured = [];
    _setInboundQueueForTests({
      add: async (name, data) => { captured.push({ name, data }); return { id: 'job-' + captured.length }; }
    });
    _resetWidgetSseForTests();
  });

  afterEach(() => {
    _setInboundQueueForTests(null);
    _resetWidgetSseForTests();
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('POST /api/widget/sessions', () => {
    it('returns 201 with the four required fields', async () => {
      const r = await request(app)
        .post('/api/widget/sessions')
        .set('X-API-Key', project.api_key)
        .send({ route: '/dashboard', viewport_w: 1280, viewport_h: 720 });
      expect(r.status).toBe(201);
      expect(r.body.session_id).toBeTruthy();
      expect(r.body.session_token).toBeTruthy();
      expect(r.body.thread_id).toBeGreaterThan(0);
      expect(r.body.sse_url).toContain(`/api/widget/sessions/${r.body.session_id}/stream`);
      expect(r.body.sse_url).toContain(`token=${encodeURIComponent(r.body.session_token)}`);
    });

    it('401 when X-API-Key is missing or invalid', async () => {
      const r1 = await request(app).post('/api/widget/sessions').send({});
      expect(r1.status).toBe(401);
      const r2 = await request(app).post('/api/widget/sessions').set('X-API-Key', 'bogus').send({});
      expect(r2.status).toBe(401);
    });

    it('persists user_agent / route / viewport on the row', async () => {
      const r = await request(app)
        .post('/api/widget/sessions')
        .set('X-API-Key', project.api_key)
        .set('User-Agent', 'TestAgent/1.0')
        .send({ route: '/x', viewport_w: 800, viewport_h: 600, locale: 'fr-FR' });
      const db = getMasterDatabase();
      const row = db.prepare(`SELECT * FROM widget_sessions WHERE session_id=?`).get(r.body.session_id);
      expect(row.user_agent).toBe('TestAgent/1.0');
      expect(row.route).toBe('/x');
      expect(row.viewport_w).toBe(800);
      expect(row.viewport_h).toBe(600);
      expect(row.locale).toBe('fr-FR');
    });
  });

  describe('POST /api/widget/sessions/:id/messages', () => {
    let session;
    beforeEach(async () => {
      const r = await request(app).post('/api/widget/sessions').set('X-API-Key', project.api_key).send({});
      session = r.body;
    });

    it('202 + writes thread_messages row + enqueues BullMQ job', async () => {
      const r = await request(app)
        .post(`/api/widget/sessions/${session.session_id}/messages`)
        .set('Authorization', `Bearer ${session.session_token}`)
        .send({ content: 'salut shelly' });
      expect(r.status).toBe(202);
      expect(r.body.message_id).toBeGreaterThan(0);
      expect(r.body.thread_id).toBe(session.thread_id);
      expect(r.body.job_id).toBe('job-1');

      const db = getMasterDatabase();
      const msg = db.prepare(`SELECT * FROM thread_messages WHERE id=?`).get(r.body.message_id);
      expect(msg.content).toBe('salut shelly');
      expect(msg.source).toBe('widget');
      expect(msg.role).toBe('user');

      expect(captured).toHaveLength(1);
      expect(captured[0].name).toBe('widget-inbound');
      expect(captured[0].data.session_id).toBe(session.session_id);
      expect(captured[0].data.project_id).toBe(project.id);
      expect(captured[0].data.content).toBe('salut shelly');
    });

    it('401 when bearer token is wrong / missing', async () => {
      const r1 = await request(app)
        .post(`/api/widget/sessions/${session.session_id}/messages`)
        .send({ content: 'x' });
      expect(r1.status).toBe(401);

      const r2 = await request(app)
        .post(`/api/widget/sessions/${session.session_id}/messages`)
        .set('Authorization', 'Bearer wrong')
        .send({ content: 'x' });
      expect(r2.status).toBe(401);
    });

    it('400 when content is missing or empty', async () => {
      const r = await request(app)
        .post(`/api/widget/sessions/${session.session_id}/messages`)
        .set('Authorization', `Bearer ${session.session_token}`)
        .send({ content: '   ' });
      expect(r.status).toBe(400);
    });

    it('400 when session id shape is invalid', async () => {
      const r = await request(app)
        .post(`/api/widget/sessions/has space/messages`)
        .set('Authorization', `Bearer ${session.session_token}`)
        .send({ content: 'x' });
      expect([400, 404]).toContain(r.status);
    });

    it('refreshes token expiry on each valid call (sliding 24h)', async () => {
      const db = getMasterDatabase();
      const before = db.prepare(`SELECT token_expires_at FROM widget_sessions WHERE session_id=?`).get(session.session_id).token_expires_at;
      // Force expiry to "now + 1h" so we can detect the slide.
      const oneHourFromNow = new Date(Date.now() + 3600 * 1000).toISOString();
      db.prepare(`UPDATE widget_sessions SET token_expires_at=? WHERE session_id=?`).run(oneHourFromNow, session.session_id);
      await request(app)
        .post(`/api/widget/sessions/${session.session_id}/messages`)
        .set('Authorization', `Bearer ${session.session_token}`)
        .send({ content: 'ping' });
      const after = db.prepare(`SELECT token_expires_at FROM widget_sessions WHERE session_id=?`).get(session.session_id).token_expires_at;
      expect(new Date(after).getTime()).toBeGreaterThan(new Date(oneHourFromNow).getTime() + 22 * 3600 * 1000);
    });
  });

  describe('POST /api/widget/sessions/:id/captures', () => {
    let session;
    beforeEach(async () => {
      const r = await request(app).post('/api/widget/sessions').set('X-API-Key', project.api_key).send({});
      session = r.body;
    });

    it('201 + writes capture row with source=widget + widget_session_id', async () => {
      const r = await request(app)
        .post(`/api/widget/sessions/${session.session_id}/captures`)
        .set('Authorization', `Bearer ${session.session_token}`)
        .send({ content: 'found a bug', kind: 'bug' });
      expect(r.status).toBe(201);
      expect(r.body.id).toBeTruthy();
      expect(r.body.source).toBe('widget');

      const db = getMasterDatabase();
      const cap = db.prepare(`SELECT * FROM captures WHERE id=?`).get(r.body.id);
      expect(cap.source).toBe('widget');
      expect(cap.widget_session_id).toBeTruthy();
      const sessRow = db.prepare(`SELECT id FROM widget_sessions WHERE session_id=?`).get(session.session_id);
      expect(cap.widget_session_id).toBe(sessRow.id);
    });

    it('401 when bearer is missing', async () => {
      const r = await request(app)
        .post(`/api/widget/sessions/${session.session_id}/captures`)
        .send({ content: 'x' });
      expect(r.status).toBe(401);
    });

    it('400 when content is empty', async () => {
      const r = await request(app)
        .post(`/api/widget/sessions/${session.session_id}/captures`)
        .set('Authorization', `Bearer ${session.session_token}`)
        .send({ content: '' });
      expect(r.status).toBe(400);
    });
  });

  describe('GET /api/widget/sessions/:id/stream', () => {
    let server, port, session;

    beforeEach(async () => {
      const r = await request(app).post('/api/widget/sessions').set('X-API-Key', project.api_key).send({});
      session = r.body;
      // Spin a real listening server so we can use native fetch streaming
      // to assert SSE bytes hit the wire.
      await new Promise((resolve) => {
        server = createServer(app).listen(0, '127.0.0.1', resolve);
      });
      port = server.address().port;
    });

    afterEach(async () => {
      if (server) await new Promise(r => server.close(r));
    });

    it('opens SSE, delivers ready event, then receives a publish', async () => {
      const url = `http://127.0.0.1:${port}/api/widget/sessions/${session.session_id}/stream?token=${encodeURIComponent(session.session_token)}`;
      const ac = new AbortController();
      const respPromise = fetch(url, { signal: ac.signal });
      const resp = await respPromise;
      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toContain('text/event-stream');
      expect(resp.headers.get('x-accel-buffering')).toBe('no');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      // Read until we see ready, then publish, then read again until message.
      async function readUntil(needle, timeoutMs = 2000) {
        const deadline = Date.now() + timeoutMs;
        while (!buf.includes(needle)) {
          if (Date.now() > deadline) throw new Error(`timeout waiting for ${needle}, got: ${buf.slice(0, 200)}`);
          const { value, done } = await reader.read();
          if (done) throw new Error('stream ended early');
          buf += decoder.decode(value, { stream: true });
        }
      }

      await readUntil('event: ready');
      // Now publish from the server side and assert the client sees it.
      publishToWidgetSession(session.session_id, 'message', { hello: 'shelly' });
      await readUntil('"hello":"shelly"');

      ac.abort();
    });

    it('401 when bearer is missing', async () => {
      const url = `http://127.0.0.1:${port}/api/widget/sessions/${session.session_id}/stream`;
      const resp = await fetch(url);
      expect(resp.status).toBe(401);
      // Drain so the socket closes promptly.
      try { await resp.text(); } catch { /* ignore */ }
    });

    it('401 when bearer is invalid', async () => {
      const url = `http://127.0.0.1:${port}/api/widget/sessions/${session.session_id}/stream?token=bogus`;
      const resp = await fetch(url);
      expect(resp.status).toBe(401);
      try { await resp.text(); } catch { /* ignore */ }
    });
  });
});
