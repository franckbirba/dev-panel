// tests/server/webhooks-glitchtip-route.test.js
//
// Integration tests for POST /api/webhooks/glitchtip/:devpanlProjectId.
// Spec: DEVPA-169 / Plane page "Observability — error tracking (GlitchTip)" §7.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import crypto from 'crypto';
import request from 'supertest';
import express from 'express';

// SECRET must be in process.env BEFORE webhooks-glitchtip.js is imported,
// because the module captures it at top-level into WEBHOOK_SECRET. setting
// it inside beforeEach is too late — the module has already loaded.
const SECRET = 'glitchtip-test-secret';
process.env.GLITCHTIP_BRIDGE_HMAC_SECRET = SECRET;
delete process.env.NODE_ENV;

const {
  initMasterDatabase,
  createProject,
  getMasterDatabase,
  closeAllDatabases
} = await import('../../src/server/db.js');
const {
  mountGlitchTipWebhook,
  __resetRateLimitsForTests
} = await import('../../src/server/webhooks-glitchtip.js');

// captures.js pulls in subjects/threads which are fine, but isolating from
// any future BullMQ reach-in.
vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ getJobs: async () => [], add: async () => ({}) }),
  QUEUES: { agent: 'agent' }
}));

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function makePayload({ action = 'created', fingerprint = ['fp-default'], extra = {} } = {}) {
  return {
    action,
    data: {
      issue: {
        id: 1,
        title: 'TypeError: cannot read property foo of undefined',
        culprit: 'app/main.js in handler',
        permalink: 'https://glitchtip.devpanl.dev/devpanl-studio/issues/1',
        fingerprint,
        metadata: {
          environment: 'production',
          exception: {
            values: [{
              stacktrace: {
                frames: [
                  { filename: 'lib/a.js', function: 'a', lineno: 10 },
                  { filename: 'lib/b.js', function: 'b', lineno: 20 }
                ]
              }
            }]
          }
        },
        breadcrumbs: { values: [{ timestamp: 1700000000, category: 'http', message: 'GET /x' }] },
        ...extra
      }
    }
  };
}

describe('POST /api/webhooks/glitchtip/:projectId', () => {
  let tmp, project, app;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-glitchtip-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo' });
    app = express();
    mountGlitchTipWebhook(app);
    __resetRateLimitsForTests();
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  // Send the JSON as a raw string body. Supertest's `.send(string)` paired
  // with `Content-Type: application/json` skips its own re-serialization, so
  // the bytes the handler receives are exactly what we signed.
  function post(projectId, body, headers = {}) {
    const raw = JSON.stringify(body);
    const req = request(app)
      .post(`/api/webhooks/glitchtip/${projectId}`)
      .type('application/json');
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req.send(raw);
  }

  it('returns 404 for unknown project', async () => {
    const body = makePayload();
    const sig = sign(SECRET, JSON.stringify(body));
    const res = await post('not-a-real-id', body, { 'x-glitchtip-signature': sig });
    expect(res.status).toBe(404);
  });

  it('returns 401 on invalid HMAC', async () => {
    const body = makePayload();
    const res = await post(project.id, body, { 'x-glitchtip-signature': 'deadbeef' });
    expect(res.status).toBe(401);
  });

  it('returns 401 when signature header is missing', async () => {
    const body = makePayload();
    const res = await post(project.id, body);
    expect(res.status).toBe(401);
  });

  it('returns 400 on missing action / issue', async () => {
    const body = { not: 'a webhook' };
    const sig = sign(SECRET, JSON.stringify(body));
    const res = await post(project.id, body, { 'x-glitchtip-signature': sig });
    expect(res.status).toBe(400);
  });

  it('returns 204 for an unhandled action', async () => {
    const body = makePayload({ action: 'noticed' });
    const sig = sign(SECRET, JSON.stringify(body));
    const res = await post(project.id, body, { 'x-glitchtip-signature': sig });
    expect(res.status).toBe(204);
  });

  it('creates a capture on first occurrence (201)', async () => {
    const body = makePayload({ fingerprint: ['err-1'] });
    const sig = sign(SECRET, JSON.stringify(body));
    const res = await post(project.id, body, { 'x-glitchtip-signature': sig });
    expect(res.status).toBe(201);
    expect(res.body.deduped).toBe(false);
    expect(res.body.occurrence_count).toBe(1);
    expect(res.body.capture_id).toBeTruthy();

    const db = getMasterDatabase();
    const row = db.prepare('SELECT * FROM captures WHERE id = ?').get(res.body.capture_id);
    expect(row.source).toBe('glitchtip');
    expect(row.status).toBe('new');
    expect(row.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(row.external_url).toContain('glitchtip.devpanl.dev');
    expect(row.environment).toBe('production');
    expect(row.content).toContain('TypeError');
    expect(row.content).toContain('--- stack trace ---');
  });

  it('dedups a second occurrence with the same fingerprint (200)', async () => {
    const body = makePayload({ fingerprint: ['err-2'] });
    const sig = sign(SECRET, JSON.stringify(body));

    const first = await post(project.id, body, { 'x-glitchtip-signature': sig });
    expect(first.status).toBe(201);
    const captureId = first.body.capture_id;

    const second = await post(project.id, body, { 'x-glitchtip-signature': sig });
    expect(second.status).toBe(200);
    expect(second.body.deduped).toBe(true);
    expect(second.body.capture_id).toBe(captureId);
    expect(second.body.occurrence_count).toBe(2);

    const db = getMasterDatabase();
    const count = db.prepare(
      'SELECT COUNT(*) AS n FROM captures WHERE fingerprint IS NOT NULL'
    ).get().n;
    expect(count).toBe(1);
  });

  it('treats `regression` like `created` and increments occurrence_count', async () => {
    const fp = ['err-regress'];
    const created = makePayload({ action: 'created', fingerprint: fp });
    const regression = makePayload({ action: 'regression', fingerprint: fp });
    await post(project.id, created, { 'x-glitchtip-signature': sign(SECRET, JSON.stringify(created)) });
    const res = await post(project.id, regression, {
      'x-glitchtip-signature': sign(SECRET, JSON.stringify(regression))
    });
    expect(res.status).toBe(200);
    expect(res.body.deduped).toBe(true);
    expect(res.body.occurrence_count).toBe(2);
  });

  it('flips status to dropped on `resolved`', async () => {
    const fp = ['err-resolved'];
    const created = makePayload({ action: 'created', fingerprint: fp });
    const c = await post(project.id, created, { 'x-glitchtip-signature': sign(SECRET, JSON.stringify(created)) });
    expect(c.status).toBe(201);
    const captureId = c.body.capture_id;

    const resolved = makePayload({ action: 'resolved', fingerprint: fp });
    const r = await post(project.id, resolved, {
      'x-glitchtip-signature': sign(SECRET, JSON.stringify(resolved))
    });
    expect(r.status).toBe(200);
    expect(r.body.resolved).toBe(captureId);

    const db = getMasterDatabase();
    const row = db.prepare('SELECT status FROM captures WHERE id = ?').get(captureId);
    expect(row.status).toBe('dropped');
  });

  it('returns 200 with resolved=null on `resolved` for an unknown fingerprint', async () => {
    const body = makePayload({ action: 'resolved', fingerprint: ['never-seen'] });
    const sig = sign(SECRET, JSON.stringify(body));
    const res = await post(project.id, body, { 'x-glitchtip-signature': sig });
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBeNull();
  });

  it('isolates dedup per project (same fingerprint, two projects)', async () => {
    const projectB = createProject({ name: 'second' });
    const body = makePayload({ fingerprint: ['shared-fp'] });
    const sig = sign(SECRET, JSON.stringify(body));

    const a = await post(project.id, body, { 'x-glitchtip-signature': sig });
    const b = await post(projectB.id, body, { 'x-glitchtip-signature': sig });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.capture_id).not.toBe(b.body.capture_id);
  });

  it('returns 429 once the per-project rate limit is exhausted', async () => {
    // Send RATE_LIMIT_MAX (100) distinct events fast, then the 101st should fail.
    let last;
    for (let i = 0; i < 100; i++) {
      const body = makePayload({ fingerprint: [`burst-${i}`] });
      const sig = sign(SECRET, JSON.stringify(body));
      last = await post(project.id, body, { 'x-glitchtip-signature': sig });
      if (last.status >= 400) break;
    }
    expect(last.status).toBe(201);

    const overflow = makePayload({ fingerprint: ['overflow'] });
    const sig = sign(SECRET, JSON.stringify(overflow));
    const res = await post(project.id, overflow, { 'x-glitchtip-signature': sig });
    expect(res.status).toBe(429);
  }, 20_000);
});
