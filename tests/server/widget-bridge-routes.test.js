// tests/server/widget-bridge-routes.test.js
//
// Covers the internal reply endpoint owned by routes-widget-bridge.js:
//   POST /api/internal/widget/sessions/:id/reply
//
// The public POST /messages and GET /stream endpoints live in
// routes-widget.js (DEVPA-161) and are exercised by tests/server/widget-route.test.js.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { defineWidgetBridgeRoutes } from '../../src/server/routes-widget-bridge.js';
import {
  publishToWidgetSession,
  subscribeWidgetSession,
  widgetSessionSubscriberCount,
  _resetWidgetSseForTests,
} from '../../src/server/widget-sse.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  // The bridge exposes only the internal endpoint, so authenticateProject is
  // unused here — pass a stub for signature parity.
  defineWidgetBridgeRoutes(router, (_req, _res, next) => next());
  app.use('/api', router);
  return app;
}

let app;

beforeEach(() => {
  _resetWidgetSseForTests();
  app = makeApp();
});

afterEach(() => {
  _resetWidgetSseForTests();
});

describe('POST /api/internal/widget/sessions/:id/reply', () => {
  let savedSecret;
  beforeEach(() => {
    savedSecret = process.env.WIDGET_INTERNAL_SECRET;
    process.env.WIDGET_INTERNAL_SECRET = 'test-secret-xyz';
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.WIDGET_INTERNAL_SECRET;
    else process.env.WIDGET_INTERNAL_SECRET = savedSecret;
  });

  it('503 if no secret configured', async () => {
    delete process.env.WIDGET_INTERNAL_SECRET;
    const r = await request(app)
      .post('/api/internal/widget/sessions/sess-abcdef/reply')
      .send({ content: 'hello' });
    expect(r.status).toBe(503);
  });

  it('401 without secret header', async () => {
    const r = await request(app)
      .post('/api/internal/widget/sessions/sess-abcdef/reply')
      .send({ content: 'hello' });
    expect(r.status).toBe(401);
  });

  it('401 with wrong secret', async () => {
    const r = await request(app)
      .post('/api/internal/widget/sessions/sess-abcdef/reply')
      .set('X-Internal-Secret', 'WRONG')
      .send({ content: 'hello' });
    expect(r.status).toBe(401);
  });

  it('400 on invalid session_id format', async () => {
    const r = await request(app)
      .post('/api/internal/widget/sessions/short/reply')
      .set('X-Internal-Secret', 'test-secret-xyz')
      .send({ content: 'hello' });
    expect(r.status).toBe(400);
  });

  it('400 on empty content', async () => {
    const r = await request(app)
      .post('/api/internal/widget/sessions/sess-abcdef/reply')
      .set('X-Internal-Secret', 'test-secret-xyz')
      .send({});
    expect(r.status).toBe(400);
  });

  it('413 on oversize content', async () => {
    const r = await request(app)
      .post('/api/internal/widget/sessions/sess-abcdef/reply')
      .set('X-Internal-Secret', 'test-secret-xyz')
      .send({ content: 'x'.repeat(16001) });
    expect(r.status).toBe(413);
  });

  it('buffers when no live SSE — message is queued for next subscriber', async () => {
    const r = await request(app)
      .post('/api/internal/widget/sessions/sess-newone/reply')
      .set('X-Internal-Secret', 'test-secret-xyz')
      .send({ content: 'salut, je suis Shelly' });
    expect(r.status).toBe(200);
    expect(r.body.delivered).toBe(0);
    expect(r.body.buffered).toBeGreaterThan(0);
  });

  it('delivers when an SSE subscriber is present', () => {
    return new Promise((resolve, reject) => {
      // Add a stream endpoint to the same app so we can subscribe via fetch.
      // We can't reuse routes-widget.js here (it requires DB + bearer auth),
      // so we mount a minimal SSE endpoint on the test app.
      const streamApp = express();
      streamApp.use(express.json());
      const router = express.Router();
      defineWidgetBridgeRoutes(router, (_req, _res, next) => next());
      router.get('/widget/sessions/:id/stream', (req, res) => {
        subscribeWidgetSession(req.params.id, res);
      });
      streamApp.use('/api', router);

      const server = streamApp.listen(0, async () => {
        try {
          const port = server.address().port;
          const session_id = 'sess-livehook';

          const ctrl = new AbortController();
          const sseRes = await fetch(
            `http://127.0.0.1:${port}/api/widget/sessions/${session_id}/stream`,
            { signal: ctrl.signal },
          );
          expect(sseRes.status).toBe(200);
          const reader = sseRes.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';

          while (!buf.includes('event: ready')) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value);
          }
          expect(widgetSessionSubscriberCount(session_id)).toBeGreaterThan(0);

          const replyResp = await fetch(
            `http://127.0.0.1:${port}/api/internal/widget/sessions/${session_id}/reply`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': 'test-secret-xyz' },
              body: JSON.stringify({ content: 'bonjour widget' }),
            },
          );
          const replyJson = await replyResp.json();
          expect(replyResp.status).toBe(200);
          expect(replyJson.delivered).toBe(1);

          while (!buf.includes('"content":"bonjour widget"')) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value);
            if (buf.length > 4096) break;
          }
          expect(buf).toContain('event: message');
          expect(buf).toContain('"content":"bonjour widget"');

          ctrl.abort();
          server.close(resolve);
        } catch (err) {
          server.close(() => reject(err));
        }
      });
    });
  });
});

describe('publishToWidgetSession buffers when no live SSE', () => {
  it('publishes to the buffer for an unknown session', () => {
    const result = publishToWidgetSession('sess-buffered', 'message', { type: 'message', content: 'reply' });
    expect(result.delivered).toBe(0);
    expect(result.buffered).toBeGreaterThan(0);
  });
});
