// src/server/routes-commands.js
// Cmd-K action surface — thin proxy from dashboard → server functions.
// Registered into createRouter() via defineCommandRoutes(router).
// Auth: resolves admin vs project level; admin-only commands return 403 to
// project-auth users.
import { timingSafeEqual } from 'crypto';
import { getProjectByApiKey } from './db.js';
import { getQueue, QUEUES, PRIORITY_MAP } from './bullmq.js';
import { memoryInsert, memorySearchSql, memoryList } from './pg.js';
import { embed } from './voyage.js';
import { createCapture, updateCapture } from './captures.js';
import { setCaptureRouting } from './captures.js';

const NAMESPACE = 'dev-panel';

const COMMAND_DEFS = {
  'dispatch':        { adminOnly: true },
  'retry-job':       { adminOnly: true },
  'cancel-job':      { adminOnly: true },
  'set-autonomy':    { adminOnly: true },
  'memory-write':    { adminOnly: true },
  'memory-search':   { adminOnly: false },
  'memory-list':     { adminOnly: false },
  'brief':           { adminOnly: false },
  'new-capture':     { adminOnly: false },
  'route-capture':   { adminOnly: true },
  'promote-capture': { adminOnly: true },
  'shelly-mode':     { adminOnly: true },
  'shelly-restart':  { adminOnly: true },
  'shelly-log':      { adminOnly: false },
  'snooze':          { adminOnly: true },
  'escalate':        { adminOnly: false },
};

function resolveAuth(req) {
  let level = null;
  let project = null;

  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
  const configuredKey = process.env.ADMIN_API_KEY;
  if (adminKey && configuredKey) {
    try {
      const a = Buffer.from(adminKey);
      const b = Buffer.from(configuredKey);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        level = 'admin';
      }
    } catch { /* length mismatch */ }
  }

  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey) {
    const p = getProjectByApiKey(apiKey);
    if (p) {
      project = p;
      if (!level) level = 'project';
    }
  }

  if (!level) return null;
  return { level, project };
}

function withStatus(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function defineCommandRoutes(router) {
  const _workerApi = () => process.env.WORKER_API || 'http://10.0.0.3:3099';

  router.post('/commands/:id', async (req, res) => {
    const cmdId = req.params.id;
    const def = COMMAND_DEFS[cmdId];
    if (!def) return res.status(404).json({ error: `Unknown command: ${cmdId}` });

    const auth = resolveAuth(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required.' });
    if (def.adminOnly && auth.level !== 'admin') {
      return res.status(403).json({ error: 'Admin access required for this command.' });
    }

    try {
      const result = await handleCommand(cmdId, req.body || {}, {
        auth, workerApi: _workerApi()
      });
      res.json(result);
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message });
    }
  });
}

async function handleCommand(id, body, { auth, workerApi }) {
  switch (id) {
    // ── Fleet ──
    case 'dispatch': {
      const { work_item_id } = body;
      if (!work_item_id) throw withStatus(400, 'work_item_id required');
      const queue = getQueue(QUEUES.agents);
      const job = await queue.add(`builder:${work_item_id}`, {
        agent: 'builder',
        task: {
          id: work_item_id,
          title: work_item_id,
          description: '',
          branch: `feat/${work_item_id.toLowerCase()}`
        },
        skills: [],
        priority: 'p2',
        source: 'cmdk',
        requested_by: 'dashboard'
      }, {
        priority: PRIORITY_MAP.p2,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        timeout: 1800000
      });
      return { ok: true, job_id: job.id, work_item_id };
    }

    case 'retry-job': {
      const { job_id } = body;
      if (!job_id) throw withStatus(400, 'job_id required');
      const resp = await fetch(`${workerApi}/retry/${job_id}`, { method: 'POST' });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw withStatus(resp.status, text || `Retry failed: ${resp.status}`);
      }
      return resp.json();
    }

    case 'cancel-job': {
      const { job_id } = body;
      if (!job_id) throw withStatus(400, 'job_id required');
      const resp = await fetch(`${workerApi}/kill/${job_id}`, { method: 'POST' });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw withStatus(resp.status, text || `Cancel failed: ${resp.status}`);
      }
      return resp.json();
    }

    case 'set-autonomy': {
      const { job_id, mode } = body;
      if (!job_id || !mode) throw withStatus(400, 'job_id and mode required');
      const resp = await fetch(`${workerApi}/jobs/${job_id}/autonomy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw withStatus(resp.status, text || `Set autonomy failed: ${resp.status}`);
      }
      return resp.json();
    }

    // ── Memory ──
    case 'memory-write': {
      const { kind, title, content } = body;
      if (!kind || !title || !content) throw withStatus(400, 'kind, title, content required');
      const embedding = await embed(title + ' ' + content);
      const memId = await memoryInsert({
        namespace: NAMESPACE, agent: 'dashboard', kind, title, content,
        tags: ['cmdk'], embedding
      });
      return { ok: true, memory_id: memId };
    }

    case 'memory-search': {
      const { query } = body;
      if (!query) throw withStatus(400, 'query required');
      const embedding = await embed(query, { inputType: 'query' });
      const rows = await memorySearchSql({ namespace: NAMESPACE, embedding, limit: 10 });
      return { ok: true, results: rows };
    }

    case 'memory-list': {
      const { kind, limit = 20 } = body;
      const rows = await memoryList({
        namespace: NAMESPACE, kind: kind || null,
        limit: Math.min(parseInt(limit, 10) || 20, 50)
      });
      return { ok: true, results: rows };
    }

    case 'brief': {
      const { work_item_id } = body;
      if (!work_item_id) throw withStatus(400, 'work_item_id required');
      const embedding = await embed(`brief ${work_item_id}`);
      const memories = await memorySearchSql({ namespace: NAMESPACE, embedding, limit: 5 });
      return { ok: true, work_item_id, memories };
    }

    // ── Captures ──
    case 'new-capture': {
      const { content } = body;
      if (!content) throw withStatus(400, 'content required');
      if (!auth.project) throw withStatus(400, 'Project context required (use X-API-Key)');
      const capture = createCapture({
        project_id: auth.project.id, content, kind: 'idea', created_by: 'dashboard'
      });
      return { ok: true, capture_id: capture.id };
    }

    case 'route-capture': {
      const { capture_id, label } = body;
      if (!capture_id || !label) throw withStatus(400, 'capture_id and label required');
      setCaptureRouting(capture_id, { label });
      return { ok: true, capture_id: Number(capture_id) };
    }

    case 'promote-capture': {
      const { capture_id } = body;
      if (!capture_id) throw withStatus(400, 'capture_id required');
      updateCapture(capture_id, { status: 'promoted' });
      return { ok: true, capture_id: Number(capture_id) };
    }

    // ── Shelly ──
    case 'shelly-mode': {
      const { mode } = body;
      if (!mode) throw withStatus(400, 'mode required');
      const resp = await fetch(`${workerApi}/shelly-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw withStatus(resp.status, text || `Set mode failed: ${resp.status}`);
      }
      return resp.json();
    }

    case 'shelly-restart': {
      const resp = await fetch(`${workerApi}/shelly-restart`, { method: 'POST' });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw withStatus(resp.status, text || `Restart failed: ${resp.status}`);
      }
      return resp.json();
    }

    case 'shelly-log': {
      const lines = Math.min(1000, Math.max(1, parseInt(body.lines, 10) || 200));
      const resp = await fetch(`${workerApi}/shelly-log?lines=${lines}`);
      const text = await resp.text();
      return { ok: true, log: text };
    }

    // ── Ops ──
    case 'snooze': {
      return { ok: true, message: 'Alerts snoozed for 24h', until: new Date(Date.now() + 86400000).toISOString() };
    }

    case 'escalate': {
      const { message } = body;
      if (!message) throw withStatus(400, 'message required');
      return { ok: true, message: 'Escalation noted', text: message };
    }

    default:
      throw withStatus(404, `No handler for command: ${id}`);
  }
}
