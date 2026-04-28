// src/server/routes-widget-bridge.js
//
// HTTP surface for the widget ↔ Shelly publique bridge.
//
// The full widget API (sessions create, history, etc.) is defined in
// routes-widget.js (DEVPA-161). This module owns the one endpoint that
// surface needs to close the loop with the public Shelly process:
//
//   POST /api/internal/widget/sessions/:id/reply
//     The widget_reply MCP tool calls this from the shelly-public process
//     to push a reply back into the SSE stream. Auth is a shared secret
//     header (`X-Internal-Secret`) — no project key, since the caller is
//     the public Shelly process which doesn't know per-project keys.

import { timingSafeEqual } from 'crypto';
import { publishToWidgetSession } from './widget-sse.js';

const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;

function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

function authenticateInternal(req, res, next) {
  const configured = process.env.WIDGET_INTERNAL_SECRET;
  if (!configured) {
    return res.status(503).json({
      error: 'WIDGET_INTERNAL_SECRET not configured — internal endpoint disabled',
    });
  }
  const provided = req.headers['x-internal-secret'];
  if (!provided) {
    return res.status(401).json({ error: 'missing X-Internal-Secret' });
  }
  const a = Buffer.from(String(provided));
  const b = Buffer.from(configured);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'invalid internal secret' });
  }
  next();
}

export function defineWidgetBridgeRoutes(router, _authenticateProject) {
  // ---------------------------------------------------------------------
  // POST /api/internal/widget/sessions/:id/reply
  //
  // Internal endpoint called by the widget_reply MCP tool inside
  // shelly-public. Pushes a reply into the SSE stream (or buffers it).
  // Body: { content, refs?, role? }
  // Auth: X-Internal-Secret header (env WIDGET_INTERNAL_SECRET).
  // ---------------------------------------------------------------------
  router.post('/internal/widget/sessions/:id/reply', authenticateInternal, (req, res) => {
    const session_id = req.params.id;
    if (!isValidSessionId(session_id)) {
      return res.status(400).json({ error: 'invalid session_id format' });
    }
    const { content, refs, role } = req.body || {};
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return res.status(400).json({ error: 'content is required' });
    }
    if (content.length > 16000) {
      return res.status(413).json({ error: 'content exceeds 16000 chars' });
    }
    const payload = {
      type: 'message',
      role: role || 'shelly',
      content,
      refs: Array.isArray(refs) ? refs : undefined,
      ts: new Date().toISOString(),
    };
    const result = publishToWidgetSession(session_id, 'message', payload);
    return res.json({ ok: true, session_id, ...result });
  });
}

// Exported for tests and for symmetry — consumers may want to reach the
// internal middleware directly.
export { authenticateInternal };
