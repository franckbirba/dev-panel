// src/server/routes-widget.js
//
// Widget chat HTTP API. Four routes:
//
//   POST /api/widget/sessions                  init session (X-API-Key)
//   GET  /api/widget/sessions/:id/stream       SSE long-lived (bearer in ?token=)
//   POST /api/widget/sessions/:id/messages     post a message (bearer)
//   POST /api/widget/sessions/:id/captures     bug/feature capture (bearer)
//
// POST /sessions is the only endpoint that takes the project X-API-Key. The
// other three authorize via the per-session bearer (`session_token`) — sent
// in the Authorization header for POSTs and in `?token=` for the SSE stream
// (because EventSource cannot set custom headers).

import { randomUUID } from 'crypto';
import { getMasterDatabase, getProjectByApiKey } from './db.js';
import {
  createWidgetSession,
  authorizeBySessionToken,
  isValidSessionId
} from './widget-sessions.js';
import { appendMessage, getOrCreateThread } from './threads.js';
import { createCapture } from './captures.js';
import { enqueueWidgetMessage } from './widget-bridge.js';
import { subscribeWidgetSession, publishToWidgetSession } from './widget-sse.js';
import { upsertSubject } from './subjects.js';
import { notifyCaptureNew } from './alerts.js';
import { autorouteCapture } from './autoroute-capture.js';
import { broadcast } from './sse.js';

const MAX_MESSAGE_LEN = 8000;
const MAX_CAPTURE_LEN = 4000;

// Project X-API-Key auth — only used by POST /sessions.
function authenticateProject(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing API key' });
  const project = getProjectByApiKey(apiKey);
  if (!project) return res.status(401).json({ error: 'Invalid API key' });
  req.project = project;
  next();
}

// Bearer token auth — used by /sessions/:id/* routes. Reads token from the
// Authorization header (`Bearer <tok>`) or the `?token=` query string for
// the SSE endpoint (EventSource cannot set headers).
function authenticateSessionBearer(req, res, next) {
  const id = req.params.id;
  if (!isValidSessionId(id)) {
    return res.status(400).json({ error: 'invalid session id' });
  }
  let token = null;
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    token = auth.slice(7).trim();
  } else if (typeof req.query.token === 'string') {
    token = req.query.token;
  }
  if (!token) return res.status(401).json({ error: 'missing bearer token' });

  const session = authorizeBySessionToken({ session_id: id, token });
  if (!session) return res.status(401).json({ error: 'invalid or expired token' });
  req.widgetSession = session;
  next();
}

export function defineWidgetRoutes(router) {
  // ---- POST /api/widget/sessions ----
  router.post('/widget/sessions', authenticateProject, (req, res) => {
    try {
      const { user_agent, route, viewport_w, viewport_h, locale } = req.body || {};
      const session = createWidgetSession({
        project_id: req.project.id,
        user_agent: user_agent ?? req.headers['user-agent'] ?? null,
        route: route ?? null,
        viewport_w: viewport_w ?? null,
        viewport_h: viewport_h ?? null,
        locale: locale ?? null
      });
      res.status(201).json({
        session_id:    session.session_id,
        session_token: session.session_token,
        sse_url:       `/api/widget/sessions/${session.session_id}/stream?token=${encodeURIComponent(session.session_token)}`,
        thread_id:     session.thread_id,
        token_expires_at: session.token_expires_at
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- GET /api/widget/sessions/:id/stream ----
  router.get('/widget/sessions/:id/stream', authenticateSessionBearer, (req, res) => {
    subscribeWidgetSession(req.widgetSession.session_id, res);
  });

  // ---- POST /api/widget/sessions/:id/messages ----
  router.post('/widget/sessions/:id/messages', authenticateSessionBearer, async (req, res) => {
    try {
      const session = req.widgetSession;
      const content = String((req.body && req.body.content) || '').trim();
      if (!content) return res.status(400).json({ error: 'content required' });
      const truncated = content.slice(0, MAX_MESSAGE_LEN);

      // Persist as a thread_messages row under subject_type='widget_session'.
      let thread_id = session.thread_id;
      if (!thread_id) {
        // Defensive: createWidgetSession should have populated it, but guard.
        const t = getOrCreateThread('widget_session', session.id);
        thread_id = t.thread_id;
      }
      const message_id = appendMessage({
        thread_id,
        role: 'user',
        source: 'widget',
        content: truncated
      });

      // Enqueue for Shelly publique. If Redis is down, surface the error so
      // the widget can retry — no silent loss.
      let job_id = null;
      try {
        job_id = await enqueueWidgetMessage({
          session_id: session.session_id,
          project_id: session.project_id,
          message_id,
          content: truncated
        });
      } catch (err) {
        return res.status(503).json({ error: `enqueue failed: ${err.message}` });
      }

      res.status(202).json({ message_id, thread_id, job_id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- POST /api/widget/sessions/:id/captures ----
  router.post('/widget/sessions/:id/captures', authenticateSessionBearer, (req, res) => {
    try {
      const session = req.widgetSession;
      const { content = '', kind = 'idea', reporter, environment, category } = req.body || {};
      const text = String(content).trim();
      if (!text) return res.status(400).json({ error: 'content required' });
      if (reporter !== undefined && reporter !== null) {
        if (typeof reporter !== 'object' || Array.isArray(reporter)) {
          return res.status(400).json({ error: 'reporter must be an object' });
        }
      }
      let env = null;
      if (environment !== undefined && environment !== null) {
        if (typeof environment !== 'string') {
          return res.status(400).json({ error: 'environment must be a string' });
        }
        const trimmed = environment.trim();
        if (trimmed.length === 0 || trimmed.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
          return res.status(400).json({ error: 'environment must be a slug (1-64 chars, [a-zA-Z0-9._-])' });
        }
        env = trimmed;
      }

      const capture = createCapture({
        project_id: session.project_id,
        content: text.slice(0, MAX_CAPTURE_LEN),
        kind: String(kind).slice(0, 32),
        reporter: reporter ?? null,
        environment: env,
        source: 'widget',
        widget_session_id: session.id
      });

      // Forward to the widget's live SSE stream so the chat UI can ack
      // immediately ({type:'capture_ack', ...}). Buffered if no subscriber.
      publishToWidgetSession(session.session_id, 'message', {
        type: 'capture_ack',
        capture_id: capture.id,
        message: 'capture received'
      });

      // Re-use the same fan-out the dashboard POST /captures uses so
      // Shelly's [capture-new] protocol stays unchanged.
      const projectName = getProjectName(session.project_id);
      notifyCaptureNew({
        project: projectName,
        capture_id: capture.id,
        category: category || '',
        content: capture.content
      }).catch(() => {});

      autorouteCapture({
        project: { id: session.project_id, name: projectName },
        capture
      }).catch(err => console.error('[autoroute] widget capture', capture.id, 'failed:', err.message));

      broadcast('inbox:invalidate', { reason: 'capture_new', capture_id: capture.id });
      res.status(201).json(capture);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

function getProjectName(project_id) {
  const db = getMasterDatabase();
  const row = db.prepare(`SELECT name FROM projects WHERE id = ?`).get(project_id);
  return row?.name ?? null;
}
