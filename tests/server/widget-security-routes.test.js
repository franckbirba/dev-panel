// tests/server/widget-security-routes.test.js
//
// End-to-end test for the widget security pipeline (DEVPA-166): the
// three widget-facing routes must redact PII from inbound content,
// rate-limit per session, and write a widget_audit row for each event.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import { initMasterDatabase, createProject, getMasterDatabase } from '../../src/server/db.js';

// Stop the route from trying to dial Telegram or BullMQ.
vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ getJobs: async () => [] }),
  QUEUES: { agent: 'agent' },
  PRIORITY_MAP: {}
}));
vi.mock('../../src/server/alerts.js', () => ({
  notifyTicket: async () => {},
  notifyTicketNew: async () => {},
  notifyCaptureNew: async () => {}
}));
vi.mock('../../src/server/autoroute-capture.js', () => ({
  autorouteCapture: async () => {}
}));

async function makeApp(tmp) {
  const { createRouter } = await import('../../src/server/routes.js');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', createRouter({ storagePath: tmp }));
  return app;
}

function rowsForSession(session_id) {
  return getMasterDatabase().prepare(
    `SELECT type FROM widget_audit WHERE session_id = ? ORDER BY id`
  ).all(session_id);
}

describe('POST /api/captures — widget security pipeline', () => {
  let app, project, tmp;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-wsec-cap-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'wsec', github_owner: 'o', github_repo: 'r' });
    app = await makeApp(tmp);
  });

  it('redacts a Bearer token from the persisted capture content + logs to console', async () => {
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const r = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .set('X-Widget-Session', 'sess-A')
      .send({ content: 'broken on prod, token Bearer abc123' });

    expect(r.status).toBe(201);
    expect(r.body.content).toBe('broken on prod, token [REDACTED]');

    // Console log must mention redaction (per AC).
    expect(logs.some(l => /redaction applied/i.test(l))).toBe(true);
    spy.mockRestore();
  });

  it('writes audit rows for message_in, redacted, capture_created', async () => {
    await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .set('X-Widget-Session', 'sess-A')
      .send({ content: 'leak Bearer xyz' })
      .expect(201);

    const types = rowsForSession('sess-A').map(r => r.type);
    expect(types).toContain('message_in');
    expect(types).toContain('redacted');
    expect(types).toContain('capture_created');
  });

  it('writes only message_in + capture_created when nothing was redacted', async () => {
    await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .set('X-Widget-Session', 'sess-clean')
      .send({ content: 'nothing sensitive here' })
      .expect(201);

    const types = rowsForSession('sess-clean').map(r => r.type);
    expect(types).toContain('message_in');
    expect(types).toContain('capture_created');
    expect(types).not.toContain('redacted');
  });

  it('returns 429 with Retry-After when a session blows past the per-min cap', async () => {
    // Pre-load 30 message_in rows for the session so the very next request is
    // the 31st and trips the per-minute limit.
    const db = getMasterDatabase();
    const insert = db.prepare(
      `INSERT INTO widget_audit (project_id, session_id, type, content_hash)
       VALUES (?, 'flood', 'message_in', 'h')`
    );
    for (let i = 0; i < 30; i++) insert.run(project.id);

    const r = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .set('X-Widget-Session', 'flood')
      .send({ content: 'one more' });

    expect(r.status).toBe(429);
    expect(r.body.reason).toBe('per_session_per_min');
    expect(r.headers['retry-after']).toBe('60');
    // The 429 response itself should be audited.
    const types = rowsForSession('flood').map(r => r.type);
    expect(types).toContain('rate_limited');
  });

  it('falls back to anon:<ip> session id when the widget omits one', async () => {
    await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'no header' })
      .expect(201);

    const db = getMasterDatabase();
    const row = db.prepare(
      `SELECT session_id FROM widget_audit
        WHERE project_id = ? ORDER BY id DESC LIMIT 1`
    ).get(project.id);
    expect(row.session_id).toMatch(/^anon:/);
  });

  it('respects per-project widget_pii_patterns from projects.widget_pii_patterns', async () => {
    const db = getMasterDatabase();
    db.prepare('UPDATE projects SET widget_pii_patterns = ? WHERE id = ?')
      .run(JSON.stringify(['INTERNAL-\\d+']), project.id);

    const r = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .set('X-Widget-Session', 'cfg-1')
      .send({ content: 'see ticket INTERNAL-9001' });

    expect(r.status).toBe(201);
    expect(r.body.content).toBe('see ticket [REDACTED]');
  });
});

describe('POST /api/threads/capture/:id/messages — widget security pipeline', () => {
  let app, project, tmp;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-wsec-thread-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'wsec-t', github_owner: 'o', github_repo: 'r' });
    app = await makeApp(tmp);
  });

  it('redacts and audits replies posted via the thread route', async () => {
    // Seed a capture so the thread exists.
    const cap = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .set('X-Widget-Session', 'sess-T')
      .send({ content: 'first' });
    expect(cap.status).toBe(201);

    const r = await request(app)
      .post(`/api/threads/capture/${cap.body.id}/messages`)
      .set('X-API-Key', project.api_key)
      .set('X-Widget-Session', 'sess-T')
      .send({ role: 'user', content: 'mail me at alice@x.io' });
    expect(r.status).toBe(200);

    // Check the persisted message has the redacted text.
    const db = getMasterDatabase();
    const msg = db.prepare(
      `SELECT content FROM thread_messages WHERE id = ?`
    ).get(r.body.id);
    expect(msg.content).toBe('mail me at [REDACTED]');

    // Audit covers both the create and the reply.
    const types = rowsForSession('sess-T').map(r => r.type);
    // 1× capture_created (from POST /captures), 2× message_in (one per request),
    // 1× redacted (the reply).
    expect(types.filter(t => t === 'message_in').length).toBeGreaterThanOrEqual(2);
    expect(types).toContain('redacted');
  });
});
