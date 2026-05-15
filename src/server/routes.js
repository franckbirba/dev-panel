import express from 'express';
import rateLimit from 'express-rate-limit';
import { timingSafeEqual } from 'crypto';
import { requireForwardedUser } from './middleware/require-forwarded-user.js';
import {
  getProjectByApiKey,
  createProject,
  listProjects,
  getProjectByName,
  getProjectById,
  getProjectByPlaneId,
  getMasterDatabase,
  updateProject,
  deleteProject,
  initProjectDatabase,
} from './db.js';
import {
  createCapture, getCapture, listCaptures, listCapturesAdmin,
  updateCapture, deleteCapture,
  setCaptureRouting, getCaptureRouting
} from './captures.js';
import { upsertSubject, getSubject, setPriority } from './subjects.js';
import { getOrCreateThread, listMessages as listThreadMessages, appendMessage as appendThreadMessage } from './threads.js';
import { buildSignalsFeed } from './signals.js';
import { prependTag } from './telegram-tag.js';
import { bootstrapFromGithub } from './projects-bootstrap.js';
import {
  getProjectDatabase,
  createTicket,
  getTicket,
  listTickets,
  updateTicket,
  deleteTicket,
  getStats,
  upsertDoc,
  listDocs,
  searchDocs,
  getDocStats,
  upsertMilestone,
  listMilestones,
  listPendingClarifications,
  answerClarification,
  logActivity,
  listActivity,
  listMessages,
  addMessage,
  setTicketRouting
} from './db.js';
import { initGitHub, listIssues, getGitHub, fetchRepoDocs, fetchMilestones, fetchIssueComments } from './github.js';
import { addClient, broadcast } from './sse.js';
import { publishTicket, rejectTicket } from './services.js';
import { getQueue, QUEUES, PRIORITY_MAP } from './bullmq.js';
import { notifyTicket, notifyTicketNew, notifyCaptureNew } from './alerts.js';
import { defineTeamRoutes } from './routes-team.js';
import { defineInboxRoutes } from './routes-inbox.js';
import { defineMemoryRoutes } from './routes-memory.js';
import { defineFleetRoutes } from './routes-fleet.js';
import { defineCommandRoutes } from './routes-commands.js';
import { defineWidgetRoutes } from './routes-widget.js';
import { defineWidgetBridgeRoutes } from './routes-widget-bridge.js';
import { routeTicket } from './ticket-routing.js';
import { routeCapture } from './capture-routing.js';
import { pool as pgPool } from './pg.js';
import { enrichWorkItems } from './plane-enrich.js';
import { redactForProject } from './widget-redaction.js';
import { auditEvent, AUDIT_TYPES } from './widget-audit.js';
import { checkRateLimit } from './widget-rate-limit.js';

// Forward a dashboard->Telegram message with delivery tracking. Tries webhook
// first (Shelly's tmux relay), then Bot API. Every attempt writes a
// telegram_outbound row so silent failures surface in the admin UI.
async function forwardToTelegram({ text, thread_message_id, subject_type, subject_id }) {
  const db = getMasterDatabase();
  const url = process.env.SHELLY_TELEGRAM_WEBHOOK;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  const transport = url ? 'webhook' : (token && chat ? 'bot_api' : 'none');
  const row = db.prepare(
    `INSERT INTO telegram_outbound
     (thread_message_id, subject_type, subject_id, text, transport, status, attempts)
     VALUES (?, ?, ?, ?, ?, 'pending', 0)`
  ).run(thread_message_id ?? null, subject_type ?? null, subject_id ?? null, text, transport);
  const outboundId = row.lastInsertRowid;
  if (transport === 'none') {
    db.prepare(
      `UPDATE telegram_outbound SET status='failed', error=?, attempts=1 WHERE id=?`
    ).run('no transport configured (set SHELLY_TELEGRAM_WEBHOOK or TELEGRAM_BOT_TOKEN+CHAT_ID)', outboundId);
    const { broadcast: b } = await import('./sse.js');
    b('telegram:outbound_failed', { id: outboundId, reason: 'no_transport' });
    return;
  }
  const attempt = async (kind, runFetch) => {
    try {
      const r = await runFetch();
      if (!r.ok) {
        const err = await r.text().catch(() => '');
        throw new Error(`${kind} ${r.status}: ${err.slice(0, 200)}`);
      }
      db.prepare(
        `UPDATE telegram_outbound SET status='delivered', delivered_at=CURRENT_TIMESTAMP,
         attempts=attempts+1, transport=? WHERE id=?`
      ).run(kind, outboundId);
      return true;
    } catch (err) {
      db.prepare(
        `UPDATE telegram_outbound SET status='pending', error=?, attempts=attempts+1 WHERE id=?`
      ).run(err.message, outboundId);
      return false;
    }
  };
  if (url) {
    const ok = await attempt('webhook', () =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    );
    if (ok) return;
  }
  if (token && chat) {
    const ok = await attempt('bot_api', () =>
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text })
      })
    );
    if (ok) return;
  }
  db.prepare(`UPDATE telegram_outbound SET status='failed' WHERE id=?`).run(outboundId);
  const { broadcast: b } = await import('./sse.js');
  b('telegram:outbound_failed', { id: outboundId });
}

// ============================================================================
// WIDGET SECURITY PIPELINE — rate-limit, PII redaction, audit logging.
// Used by the three widget-facing routes (POST /captures, POST
// /captures/:id/messages, POST /threads/capture/:id/messages). Returns
// { ok: true, content, session_id } on success or { ok: false, response }
// where response is { status, body, retryAfter? } and the caller forwards
// it. Spec: DEVPA-166.
// ============================================================================

function extractSessionId(req) {
  const fromHeader = req.headers['x-widget-session'];
  const fromBody = req.body && typeof req.body.session_id === 'string' ? req.body.session_id : null;
  const raw = fromHeader || fromBody;
  if (!raw || typeof raw !== 'string') return null;
  // Cap length so a malicious caller can't pump huge payloads through
  // the audit table.
  return raw.slice(0, 128);
}

function applyWidgetSecurity({ project_id, type, content, req }) {
  const session_id = extractSessionId(req) || `anon:${req.ip || 'unknown'}`;

  // 1. Rate-limit BEFORE we write any other audit row, so a flooding
  // session doesn't get to inflate its own counters. We still write a
  // single rate_limited row so post-incident analysis sees the burst.
  const rl = checkRateLimit({ project_id, session_id });
  if (!rl.allowed) {
    try {
      auditEvent({ project_id, session_id, type: AUDIT_TYPES.RATE_LIMITED });
    } catch (e) {
      console.error('[widget-security] audit rate_limited failed:', e.message);
    }
    return {
      ok: false,
      response: {
        status: 429,
        body: { error: 'Too many requests', reason: rl.reason },
        retryAfter: rl.retryAfter
      }
    };
  }

  // 2. Redact PII from the content.
  const { text: redacted, count, types } = redactForProject(project_id, content || '');
  if (count > 0) {
    console.log(`[widget-security] redaction applied project=${project_id} session=${session_id} types=${types.join(',')} count=${count}`);
    try {
      auditEvent({ project_id, session_id, type: AUDIT_TYPES.REDACTED, content: String(content) });
    } catch (e) {
      console.error('[widget-security] audit redacted failed:', e.message);
    }
  }

  // 3. Audit the inbound event itself (post-redaction so the hash matches
  // what's actually persisted downstream).
  try {
    auditEvent({ project_id, session_id, type, content: redacted });
  } catch (e) {
    console.error('[widget-security] audit message_in failed:', e.message);
  }

  return { ok: true, content: redacted, session_id };
}

// ============================================================================
// MIDDLEWARE - API Key Auth
// ============================================================================

function authenticateProject(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key. Provide via X-API-Key header or api_key query param.' });
  }

  const project = getProjectByApiKey(apiKey);

  if (!project) {
    return res.status(401).json({ error: 'Invalid API key.' });
  }

  // Attach project to request
  req.project = project;
  next();
}

// SPA bootstrap auth: accept (a) admin key (CLI) OR (b) trusted forwarded
// user (browser through Traefik SSO). Plain project API keys are NOT
// accepted here — these routes return ALL projects, which a single project
// key must not unlock.
function authenticateSpaBootstrap(req, res, next) {
  // Admin key path — short-circuit if header matches.
  const adminKey = req.headers['x-admin-key'];
  const configured = process.env.ADMIN_API_KEY;
  if (adminKey && configured) {
    const a = Buffer.from(adminKey);
    const b = Buffer.from(configured);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      req.user = { type: 'admin_key' };
      return next();
    }
  }
  // Otherwise require the forwarded-user header.
  return requireForwardedUser(req, res, next);
}

// Tiny JSON parse with fallback — used by /admin/auto-decisions to inflate
// the stored undo_hint TEXT column without crashing on legacy malformed rows.
function safeJSON(s) {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function createRouter(config = {}) {
  const router = express.Router();
  const storagePath = config.storagePath || './storage';

  // Rate limiters
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
  });

  const ticketCreateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many ticket submissions, please try again later.' }
  });

  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many auth attempts, please try again later.' }
  });

  // Apply global rate limit
  router.use(globalLimiter);

  // Admin authentication middleware
  function authenticateAdmin(req, res, next) {
    // EventSource can't set headers, so SSE consumers pass ?admin_key=... in
    // the URL. Header still preferred for normal requests.
    const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
    const configuredKey = process.env.ADMIN_API_KEY;

    if (!configuredKey) {
      // No admin key configured = admin endpoints disabled in production
      if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'Admin endpoints disabled. Set ADMIN_API_KEY.' });
      }
      // In dev, allow without key
      return next();
    }

    if (!adminKey) {
      return res.status(401).json({ error: 'Invalid or missing admin key. Provide via X-Admin-Key header or admin_key query param.' });
    }

    const adminBuf = Buffer.from(adminKey);
    const configBuf = Buffer.from(configuredKey);
    if (adminBuf.length !== configBuf.length || !timingSafeEqual(adminBuf, configBuf)) {
      return res.status(401).json({ error: 'Invalid or missing admin key. Provide via X-Admin-Key header.' });
    }

    next();
  }

  // ============================================================================
  // PUBLIC ENDPOINTS (No auth)
  // ============================================================================

  // Health check — basic
  router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Identity for the SPA. Returns whoever the request resolved to via
  // authenticateSpaBootstrap — that's either the SSO email (traefik) or
  // the synthetic dev@localhost user (DASHBOARD_DEV_BYPASS_SSO). The chat
  // sidebar renders this in the footer; without it there's no profile
  // surface in the UI.
  router.get('/me', authenticateSpaBootstrap, (req, res) => {
    const user = req.user || {};
    const email = user.email || null;
    const name = email ? email.split('@')[0].replace(/[._-]+/g, ' ') : 'admin';
    // DASHBOARD_DEV_BYPASS_SSO mints a synthetic forwarded_user, but there
    // is no Google session behind it — hide the sign-out link in that
    // mode so the UI doesn't link to a dead /_oauth/logout.
    const realSso = user.type === 'forwarded_user'
      && process.env.TRUST_FORWARDED_USER === 'true';
    res.json({
      type: user.type || 'unknown',
      email,
      name,
      logout_url: realSso ? '/_oauth/logout' : null,
    });
  });

  // Health check — detailed (admin only)
  router.get('/health/detailed', authenticateAdmin, async (req, res) => {
    const { getHealthStatus } = await import('./monitoring.js');
    const health = await getHealthStatus(storagePath);

    res.status(health.status === 'down' ? 503 : 200).json(health);
  });

  // Queue health
  router.get('/health/queues', authenticateSpaBootstrap, async (req, res) => {
    try {
      const { getAllQueuesHealth } = await import('./bullmq.js');
      // Bound the queue check — Redis may be unreachable in local dev, and
      // BullMQ retries silently before timing out, so the request would
      // otherwise hang for tens of seconds.
      const timeoutMs = 2500;
      const health = await Promise.race([
        getAllQueuesHealth(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`redis unreachable (>${timeoutMs}ms)`)), timeoutMs),
        ),
      ]);
      res.status(health.status === 'critical' ? 503 : 200).json(health);
    } catch (error) {
      res.status(200).json({ status: 'unknown', queues: [], error: error.message });
    }
  });

  // Dead Letter Queue
  router.get('/admin/dlq', authenticateAdmin, async (req, res) => {
    try {
      const { getDLQJobs } = await import('./bullmq.js');
      const jobs = await getDLQJobs();

      res.json({ count: jobs.length, jobs });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Retry DLQ job
  router.post('/admin/dlq/:jobId/retry', authenticateAdmin, async (req, res) => {
    try {
      const { retryFromDLQ } = await import('./bullmq.js');
      const newJob = await retryFromDLQ(req.params.jobId);

      res.json({ message: 'Job retried', job_id: newJob.id });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // SSO allowlist — read/write infra/config/oauth2-proxy-emails.txt via the
  // GitHub Contents API. Each commit triggers CI which renders the allowlist
  // and refreshes oauth2-proxy. Live within ~30s.
  router.get('/admin/allowlist', authenticateAdmin, async (req, res) => {
    try {
      const { listAllowlist } = await import('./allowlist.js');
      res.json({ emails: await listAllowlist() });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/admin/allowlist', authenticateAdmin, async (req, res) => {
    const { email } = req.body || {};
    try {
      const { addEmail } = await import('./allowlist.js');
      const result = await addEmail(email);
      res.json(result);
    } catch (error) {
      if (error.code === 'INVALID_EMAIL') return res.status(400).json({ error: 'invalid email' });
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/admin/allowlist/:email', authenticateAdmin, async (req, res) => {
    try {
      const { removeEmail } = await import('./allowlist.js');
      const result = await removeEmail(req.params.email);
      res.json(result);
    } catch (error) {
      if (error.code === 'WOULD_EMPTY_ALLOWLIST') {
        return res.status(400).json({ error: 'cannot remove the last email' });
      }
      if (error.code === 'INVALID_EMAIL') return res.status(400).json({ error: 'invalid email' });
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================================
  // QUEUE MONITORING ENDPOINTS
  // ============================================================================

  // Queue name validation middleware
  async function resolveQueue(req, res, next) {
    const { resolveQueueName } = await import('./bullmq.js');
    const fullName = resolveQueueName(req.params.name);
    if (!fullName) {
      return res.status(404).json({ error: `Unknown queue: ${req.params.name}` });
    }
    req.queueName = fullName;
    next();
  }

  // List all queues with counts (project auth)
  router.get('/queues', authenticateProject, async (req, res) => {
    try {
      const { getAllQueuesHealth } = await import('./bullmq.js');
      const health = await getAllQueuesHealth();
      res.json(health);
    } catch (error) {
      if (error.message?.includes('ECONNREFUSED') || error.message?.includes('NOAUTH')) {
        return res.status(503).json({ error: 'Redis unavailable', status: 'unreachable' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // List jobs in a queue (project auth)
  router.get('/queues/:name/jobs', authenticateProject, resolveQueue, async (req, res) => {
    try {
      const { getQueueJobs } = await import('./bullmq.js');
      const { status = 'waiting', start = '0', limit = '50' } = req.query;
      const jobs = await getQueueJobs(req.queueName, status, parseInt(start), parseInt(limit));
      res.json({ queue: req.queueName, status, jobs });
    } catch (error) {
      if (error.message?.includes('ECONNREFUSED')) {
        return res.status(503).json({ error: 'Redis unavailable' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Get job detail (project auth)
  router.get('/queues/:name/jobs/:id', authenticateProject, resolveQueue, async (req, res) => {
    try {
      const { getJobDetail } = await import('./bullmq.js');
      const job = await getJobDetail(req.queueName, req.params.id);
      if (!job) {
        return res.status(404).json({ error: `Job ${req.params.id} not found` });
      }
      res.json(job);
    } catch (error) {
      if (error.message?.includes('ECONNREFUSED')) {
        return res.status(503).json({ error: 'Redis unavailable' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Pause queue (admin auth)
  router.post('/queues/:name/pause', authenticateAdmin, resolveQueue, async (req, res) => {
    try {
      const { getQueue } = await import('./bullmq.js');
      const queue = getQueue(req.queueName);
      await queue.pause();
      res.json({ message: `Queue ${req.queueName} paused` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Resume queue (admin auth)
  router.post('/queues/:name/resume', authenticateAdmin, resolveQueue, async (req, res) => {
    try {
      const { getQueue } = await import('./bullmq.js');
      const queue = getQueue(req.queueName);
      await queue.resume();
      res.json({ message: `Queue ${req.queueName} resumed` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Clean queue (admin auth)
  router.post('/queues/:name/clean', authenticateAdmin, resolveQueue, async (req, res) => {
    try {
      const { getQueue } = await import('./bullmq.js');
      const queue = getQueue(req.queueName);
      const { grace = '0', status = 'completed', limit = '100' } = req.body;
      const removed = await queue.clean(parseInt(grace), parseInt(limit), status);
      res.json({ message: `Cleaned ${removed.length} ${status} jobs`, removed: removed.length });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Retry a failed job (admin auth)
  router.post('/queues/:name/jobs/:id/retry', authenticateAdmin, resolveQueue, async (req, res) => {
    try {
      const { getQueue } = await import('./bullmq.js');
      const queue = getQueue(req.queueName);
      const job = await queue.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: `Job ${req.params.id} not found` });
      }
      await job.retry();
      res.json({ message: `Job ${req.params.id} retried` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Remove a job (admin auth)
  router.delete('/queues/:name/jobs/:id', authenticateAdmin, resolveQueue, async (req, res) => {
    try {
      const { getQueue } = await import('./bullmq.js');
      const queue = getQueue(req.queueName);
      const job = await queue.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: `Job ${req.params.id} not found` });
      }
      await job.remove();
      res.json({ message: `Job ${req.params.id} removed` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Promote a delayed job (admin auth)
  router.post('/queues/:name/jobs/:id/promote', authenticateAdmin, resolveQueue, async (req, res) => {
    try {
      const { getQueue } = await import('./bullmq.js');
      const queue = getQueue(req.queueName);
      const job = await queue.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: `Job ${req.params.id} not found` });
      }
      await job.promote();
      res.json({ message: `Job ${req.params.id} promoted` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================================
  // JOB ENQUEUE (Dashboard)
  // ============================================================================

  router.post('/api/jobs', authenticateAdmin, async (req, res) => {
    try {
      const { agent, task_id, task_title, task_description, skills, priority, branch, source } = req.body;

      if (!agent || !task_id || !task_title) {
        return res.status(400).json({ error: 'Required: agent, task_id, task_title' });
      }

      const queue = getQueue(QUEUES.agents);
      const job = await queue.add(`${agent}:${task_id}`, {
        agent,
        task: {
          id: task_id,
          title: task_title,
          description: task_description || '',
          branch: branch || `feat/${task_id.toLowerCase()}`
        },
        skills: skills || [],
        priority: priority || 'p2',
        source: source || 'dashboard',
        requested_by: 'dashboard'
      }, {
        priority: PRIORITY_MAP[priority] || PRIORITY_MAP.p2,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        timeout: 1800000
      });

      res.json({ job_id: job.id, agent, task_id, priority: priority || 'p2' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================================
  // JOB KILL (Dashboard -> Worker API proxy)
  // ============================================================================

  router.post('/api/jobs/:id/kill', authenticateAdmin, async (req, res) => {
    const workerApi = process.env.WORKER_API || 'http://62.238.0.167:3099';
    try {
      const resp = await fetch(`${workerApi}/kill/${req.params.id}`, { method: 'POST' });
      const data = await resp.json();
      res.status(resp.status).json(data);
    } catch (err) {
      res.status(502).json({ error: `Cannot reach worker: ${err.message}` });
    }
  });

  // ============================================================================
  // SHELLY MONITORING (Dashboard pane + uptime-kuma)
  // Router is mounted at /api in src/server/index.js so paths here are
  // relative — final URLs are /api/shelly/{health,status,log}.
  //   - /api/shelly/health   → public, proxies worker; uptime-kuma polls this
  //   - /api/shelly/status   → admin, full diagnostics body for the dashboard
  //   - /api/shelly/log      → admin, text/plain tail of /home/deploy/logs/shelly.log
  // ============================================================================

  const _workerApi = () => process.env.WORKER_API || 'http://10.0.0.3:3099';

  router.get('/shelly/health', async (req, res) => {
    try {
      const resp = await fetch(`${_workerApi()}/shelly-health`);
      // Mirror status code so kuma's "expected status 200" check works.
      res.status(resp.status);
      res.type('application/json').send(await resp.text());
    } catch (err) {
      res.status(502).json({ healthy: false, error: `worker unreachable: ${err.message}` });
    }
  });

  router.get('/shelly/status', authenticateProject, async (req, res) => {
    try {
      const resp = await fetch(`${_workerApi()}/shelly-health`);
      const body = await resp.json();
      res.status(resp.ok ? 200 : 200).json(body); // dashboard wants the body either way
    } catch (err) {
      res.status(502).json({ healthy: false, error: `worker unreachable: ${err.message}` });
    }
  });

  router.get('/shelly/log', authenticateProject, async (req, res) => {
    const lines = Math.min(1000, Math.max(1, parseInt(req.query.lines, 10) || 200));
    try {
      const resp = await fetch(`${_workerApi()}/shelly-log?lines=${lines}`);
      res.status(resp.status).type('text/plain').send(await resp.text());
    } catch (err) {
      res.status(502).type('text/plain').send(`worker unreachable: ${err.message}`);
    }
  });

  // Local log tail — SPA bootstrap auth. Two paths:
  //   1. Docker socket mounted (production): query Docker engine API for
  //      stdout/stderr of a hardcoded set of container names.
  //   2. Fallback (dev laptop): read /tmp/devpanel-*.log files tee'd by
  //      `npm run dev` and friends.
  router.get('/admin/local-log', authenticateSpaBootstrap, async (req, res) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    // source → { container: <prod container name>, file: <dev fallback path> }
    // worker has no `container` because in prod it runs as systemd on the
    // agents host (10.0.0.3), unreachable from services' docker socket.
    // The agents-host worker streams its per-job stderr into Pg
    // (agent_job_events) so use the /api/admin/jobs/:id/events stream for
    // worker output; this endpoint surfaces only services-host containers.
    const SOURCES = {
      backend: { container: 'devpanel-api',     file: '/tmp/devpanel-backend.log' },
      next:    { container: null,               file: '/tmp/next-chat-dev.log' },
      worker:  { container: null,               file: '/tmp/devpanel-worker.log' },
    };
    const source = String(req.query.source || 'backend');
    const spec = SOURCES[source];
    if (!spec) {
      return res.status(400).type('text/plain')
        .send(`unknown source: ${source}. allowed: ${Object.keys(SOURCES).join(', ')}`);
    }
    const lines = Math.min(2000, Math.max(1, parseInt(req.query.lines, 10) || 500));

    const sockPath = '/var/run/docker.sock';
    const hasDockerSock = spec.container && fs.existsSync(sockPath);

    if (hasDockerSock) {
      // Docker Engine API: GET /containers/<name>/logs?stdout=1&stderr=1&tail=N
      // Returns a multiplexed stream with 8-byte frame headers when stdin
      // is not attached (which is our case for service containers).
      try {
        const http = await import('node:http');
        const url = `/containers/${encodeURIComponent(spec.container)}/logs` +
          `?stdout=1&stderr=1&timestamps=0&tail=${lines}`;
        const chunks = [];
        await new Promise((resolve, reject) => {
          const req2 = http.request({
            socketPath: sockPath,
            path: url,
            method: 'GET',
          }, (resp) => {
            if (resp.statusCode !== 200) {
              return reject(new Error(`docker engine HTTP ${resp.statusCode}`));
            }
            resp.on('data', (c) => chunks.push(c));
            resp.on('end', resolve);
            resp.on('error', reject);
          });
          req2.on('error', reject);
          req2.setTimeout(5000, () => req2.destroy(new Error('docker engine timeout')));
          req2.end();
        });
        // De-multiplex: each frame is [stream(1), 0,0,0, size(4be), payload].
        // For TTY containers Docker returns raw bytes (no header). Detect
        // by checking the first byte: 1/2 = stdout/stderr framing.
        const buf = Buffer.concat(chunks);
        let out = '';
        if (buf.length === 0) {
          out = `# ${spec.container} has no recent output (last ${lines} lines).\n`;
        } else if (buf[0] === 0 || buf[0] === 1 || buf[0] === 2) {
          // Framed
          let i = 0;
          while (i + 8 <= buf.length) {
            const size = buf.readUInt32BE(i + 4);
            const end = i + 8 + size;
            if (end > buf.length) break;
            out += buf.slice(i + 8, end).toString('utf8');
            i = end;
          }
        } else {
          out = buf.toString('utf8');
        }
        return res.status(200).type('text/plain').send(out);
      } catch {
        // Fall through to the dev-laptop file fallback. Common when the
        // docker.sock is mounted (e.g. Docker Desktop on a dev machine)
        // but the target container isn't running locally.
      }
    }

    // Dev-laptop fallback
    const file = spec.file;
    if (!file) {
      return res.status(404).type('text/plain')
        .send(`# source '${source}' has no fallback file path.\n`);
    }
    try {
      if (!fs.existsSync(file)) {
        return res.status(200).type('text/plain')
          .send(`# ${path.basename(file)} not found yet — process may not have logged anything.\n`);
      }
      const buf = fs.readFileSync(file, 'utf8');
      const all = buf.split('\n');
      const tail = all.slice(-lines).join('\n');
      res.status(200).type('text/plain').send(tail);
    } catch (err) {
      res.status(500).type('text/plain').send(`local-log error: ${err.message}`);
    }
  });

  // Local sandboxed shell — SPA bootstrap auth, allowlisted commands only.
  // Used by the Workbench Shell view.
  router.post('/admin/shell', authenticateSpaBootstrap, async (req, res) => {
    const { execFile } = await import('node:child_process');
    const ALLOW = new Set([
      'ls','pwd','cat','echo','date','uname','node','npm','git',
      'curl','ps','df','du','head','tail','grep','find',
    ]);
    const cmd = String(req.body?.cmd || '').trim();
    if (!cmd) return res.status(400).json({ error: 'empty command' });
    if (cmd.length > 2000) return res.status(400).json({ error: 'command too long' });
    if (/[;&|`$><\n\r]/.test(cmd)) {
      return res.status(400).json({ error: 'shell metacharacters not allowed' });
    }
    const parts = cmd.split(/\s+/);
    const head = parts[0];
    const args = parts.slice(1);
    if (!ALLOW.has(head)) {
      return res.status(400).json({ error: `'${head}' not in allowlist` });
    }
    execFile(head, args, {
      timeout: 10_000,
      maxBuffer: 100 * 1024,
      cwd: process.cwd(),
    }, (err, stdout, stderr) => {
      if (err && err.killed) {
        return res.status(504).json({ error: 'timed out (10s)', stdout, stderr });
      }
      res.status(200).json({
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        exit_code: err?.code ?? 0,
      });
    });
  });

  // Metrics (Prometheus-compatible)
  router.get('/metrics', async (req, res) => {
    const { getMetrics } = await import('./monitoring.js');
    const metrics = await getMetrics(storagePath);

    // Convert to Prometheus text format
    let output = '';
    output += `# HELP devpanel_uptime_seconds Process uptime\n`;
    output += `# TYPE devpanel_uptime_seconds gauge\n`;
    output += `devpanel_uptime_seconds ${metrics.process.uptime_seconds}\n\n`;

    output += `# HELP devpanel_memory_rss_bytes Resident set size\n`;
    output += `# TYPE devpanel_memory_rss_bytes gauge\n`;
    output += `devpanel_memory_rss_bytes ${metrics.process.memory_rss_bytes}\n\n`;

    output += `# HELP devpanel_memory_heap_used_bytes Heap used\n`;
    output += `# TYPE devpanel_memory_heap_used_bytes gauge\n`;
    output += `devpanel_memory_heap_used_bytes ${metrics.process.memory_heap_used_bytes}\n\n`;

    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(output);
  });

  // ============================================================================
  // PROJECT MANAGEMENT (No project auth - admin endpoints)
  // ============================================================================

  // List all projects — SPA bootstrap gate. A forwarded-user (browser through
  // Traefik SSO) or admin key (CLI / scripts) may list all projects. Project
  // API keys are NOT accepted — a project key must not expose sibling projects.
  router.get('/projects', authLimiter, authenticateSpaBootstrap, (req, res) => {
    try {
      const projects = listProjects();
      res.json({ projects });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================================
  // MULTI-PROJECT DASHBOARD SUPPORT
  //
  // /whoami           — project key auth, returns the calling project + metrics.
  //                     Used by the dashboard to identify which project an
  //                     api key belongs to (e.g. when the user pastes a key
  //                     to add a project to the local switcher).
  // /projects/summary — admin auth, returns every project + metrics + api_key.
  //                     Powers "import all my projects" + cross-project ribbon.
  // POST /projects    — admin, create a project with full metadata.
  // PATCH /projects/:id — admin, edit metadata.
  // DELETE /projects/:id — admin, drop a project.
  // ============================================================================

  function projectMetrics(project) {
    let stats = { total: 0, pending: 0, published: 0, rejected: 0 };
    try { stats = getStats(storagePath, project.id) || stats; }
    catch { /* per-project db may not exist yet for fresh imports */ }

    // Active workflow count is project-scoped via plane_project_id when set,
    // otherwise we fall back to a global count so demo/dev projects still
    // show *something* in the ribbon.
    let activeWorkflows = 0;
    try {
      const masterDb = getMasterDatabase();
      if (project.plane_project_id) {
        // workflow_instances doesn't carry plane_project_id directly; the
        // dispatch path puts it in metadata when present. Fall back to a
        // simple count if metadata isn't structured.
        activeWorkflows = masterDb.prepare(
          `SELECT COUNT(*) AS n FROM workflow_instances
             WHERE status IN ('running','awaiting_approval')
               AND (metadata LIKE ? OR metadata IS NULL)`
        ).get(`%${project.plane_project_id}%`).n || 0;
      } else {
        activeWorkflows = masterDb.prepare(
          `SELECT COUNT(*) AS n FROM workflow_instances
             WHERE status IN ('running','awaiting_approval')`
        ).get().n || 0;
      }
    } catch { /* table may be empty */ }

    let lastActivity = null;
    try {
      const recent = listActivity(storagePath, project.id, 1);
      if (recent && recent[0]) lastActivity = recent[0].created_at;
    } catch { /* db may not exist yet */ }

    return {
      id: project.id,
      name: project.name,
      description: project.description || null,
      github_owner: project.github_owner || null,
      github_repo: project.github_repo || null,
      plane_project_id: project.plane_project_id || null,
      plane_workspace_slug: project.plane_workspace_slug || null,
      default_branch: project.default_branch || null,
      local_path: project.local_path || null,
      created_at: project.created_at,
      updated_at: project.updated_at || project.created_at,
      stats,
      active_workflows: activeWorkflows,
      last_activity: lastActivity
    };
  }

  // Resolve which project an api key belongs to + return its metrics.
  router.get('/whoami', authenticateProject, (req, res) => {
    try {
      const m = projectMetrics(req.project);
      res.json({ ...m, api_key: req.project.api_key });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/projects/summary', authLimiter, authenticateAdmin, (req, res) => {
    try {
      const enriched = listProjects().map(p => ({ ...projectMetrics(p), api_key: p.api_key }));
      res.json({ projects: enriched });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // /admin/projects — slim list for M2M consumers (worker pr-scanner cron).
  // Lives under /api/admin/* so it matches the M2M traefik router (catch-all
  // /api/*, no oauth-google) instead of the higher-priority SPA router which
  // captures /api/projects(/summary) and forces SSO.
  router.get('/admin/projects', authenticateAdmin, (req, res) => {
    try {
      // api_key is included so M2M consumers (MCP resolveProjectByName)
      // can subsequently call per-project routes that gate on X-API-Key
      // (e.g. /api/team/labels).
      // plane_project_id + plane_workspace_slug + local_path are included
      // so the worker's UUID-fan-out resolver (DEVPA-180 follow-up) can
      // discover which Plane project owns a UUID without an extra round-trip
      // — and so pr-scanner enumerates only repos with a Plane mapping.
      // Endpoint is admin-auth only.
      const projects = listProjects().map(p => ({
        id: p.id,
        name: p.name,
        github_owner: p.github_owner,
        github_repo: p.github_repo,
        api_key: p.api_key,
        plane_project_id: p.plane_project_id,
        plane_workspace_slug: p.plane_workspace_slug,
        local_path: p.local_path,
        default_branch: p.default_branch
      }));
      res.json({ projects });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // /admin/projects/by-plane-id/:plane_project_id — resolve a Plane project_id
  // to the local checkout config used by the dispatcher. Lives services-side
  // because the projects table is the single source of truth: agents-host MCP
  // and worker can't trust their own SQLite (which is empty on agents). See
  // DEVPA-180 for the bug this fixes — a Zeno dispatch was returning
  // project_not_linked because the dispatcher was reading a stale local DB.
  router.get('/admin/projects/by-plane-id/:plane_project_id', authenticateAdmin, (req, res) => {
    try {
      const proj = getProjectByPlaneId(req.params.plane_project_id);
      if (!proj) {
        return res.status(404).json({ error: 'project_not_linked' });
      }
      res.json({
        id: proj.id,
        name: proj.name,
        github_owner: proj.github_owner,
        github_repo: proj.github_repo,
        plane_project_id: proj.plane_project_id,
        plane_workspace_slug: proj.plane_workspace_slug,
        local_path: proj.local_path,
        default_branch: proj.default_branch
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // /admin/captures — cross-project capture list for the agents host. The
  // per-project GET /api/captures requires X-API-Key (one project at a time);
  // Shelly + ephemeral agents only carry ADMIN_API_KEY, hence this admin twin.
  // Filters: project_id (optional UUID), status, kind, limit (≤200).
  router.get('/admin/captures', authenticateAdmin, (req, res) => {
    try {
      const project_id = req.query.project_id ? String(req.query.project_id) : null;
      const status = req.query.status ? String(req.query.status) : null;
      const kind = req.query.kind ? String(req.query.kind) : null;
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      res.json({ captures: listCapturesAdmin({ project_id, status, kind, limit }) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Admin per-capture detail. The project-keyed /captures/:id requires the
  // project's API key, which the chat handler doesn't carry — admin path
  // lets the `capture_detail` capability look up by uuid alone.
  router.get('/admin/captures/:id', authenticateAdmin, (req, res) => {
    try {
      const cap = getCapture(req.params.id);
      if (!cap) return res.status(404).json({ error: 'capture not found' });
      res.json({ capture: cap });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Admin twin of PATCH /captures/:id — same allowed fields, no project-key
  // tenancy check (admin key already gates the route). Used by the
  // `promote_capture` capability to mark a capture promoted with the new
  // plane_work_item_id + plane_sequence_id after the Plane WI is created.
  // (DEVPA-217 — closes the half-baked behavior described in
  // src/capabilities/promote-capture.js's deferred-patch comment.)
  router.patch('/admin/captures/:id', authenticateAdmin, (req, res) => {
    try {
      const cap = getCapture(req.params.id);
      if (!cap) return res.status(404).json({ error: 'capture not found' });
      res.json(updateCapture(req.params.id, req.body || {}));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================================
  // BOSS-COS — auto_decisions audit trail
  //
  // Shelly logs reversible decisions she takes without asking via POST. The
  // dashboard's AutoDecisionsPanel reads via GET. Franck rolls back via the
  // /:id/rollback endpoint, which marks the row rolled-back (the actual
  // inverse-action is Shelly's job — the rollback flag is the "execute it"
  // signal she watches for in the next turn).
  // ============================================================================

  router.get('/admin/auto-decisions', authenticateSpaBootstrap, (req, res) => {
    try {
      const db = getMasterDatabase();
      const sinceISO = req.query.since
        ? String(req.query.since)
        : new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const includeRB = req.query.include_rolled_back === '1';
      const projectId = req.query.project_id ? String(req.query.project_id) : null;
      let sql = `SELECT id, project_id, kind, what, why, undo_hint, ts, rolled_back_at, rolled_back_by
                   FROM auto_decisions WHERE ts >= ?`;
      const params = [sinceISO];
      if (!includeRB) sql += ` AND rolled_back_at IS NULL`;
      if (projectId) { sql += ` AND project_id = ?`; params.push(projectId); }
      sql += ` ORDER BY ts DESC LIMIT ?`;
      params.push(limit);
      const rows = db.prepare(sql).all(...params).map(r => ({
        ...r,
        undo_hint: r.undo_hint ? safeJSON(r.undo_hint) : null,
      }));
      res.json({ decisions: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/admin/auto-decisions', authenticateAdmin, (req, res) => {
    try {
      const { kind, what, why = null, undo_hint = null, project_id = null } = req.body || {};
      if (!kind || !what) return res.status(400).json({ error: 'kind and what required' });
      const db = getMasterDatabase();
      const r = db.prepare(
        `INSERT INTO auto_decisions (project_id, kind, what, why, undo_hint)
         VALUES (?, ?, ?, ?, ?)`
      ).run(project_id, kind, what, why, undo_hint ? JSON.stringify(undo_hint) : null);
      res.json({ id: r.lastInsertRowid, kind, what });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/admin/auto-decisions/:id/rollback', authenticateSpaBootstrap, (req, res) => {
    try {
      const db = getMasterDatabase();
      const row = db.prepare(`SELECT * FROM auto_decisions WHERE id = ?`).get(req.params.id);
      if (!row) return res.status(404).json({ error: 'not found' });
      if (row.rolled_back_at) return res.status(409).json({ error: 'already rolled back' });
      const rolledBy = req.body?.by || 'franck';
      db.prepare(
        `UPDATE auto_decisions SET rolled_back_at = CURRENT_TIMESTAMP, rolled_back_by = ? WHERE id = ?`
      ).run(rolledBy, req.params.id);
      res.json({ id: Number(req.params.id), rolled_back: true, undo_hint: row.undo_hint ? safeJSON(row.undo_hint) : null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================================
  // SUBJECT GRAPH — universal join key across the studio's 11+ silos.
  //
  // The threads table already keys conversations by (subject_type, subject_id).
  // subject_links extends that to typed edges between subjects, so Shelly can
  // navigate from a capture → its promoted work item → linked PRs → fleet runs
  // → memories → glitchtip issues, in one round-trip.
  //
  // Edge writers: webhooks (merge-coordinator, glitchtip bridge), capabilities
  // (promote_capture writes capture→work_item), and Shelly herself when she
  // creates an AFFiNE doc / Plane Page about a subject (subject_link MCP tool).
  // Edge readers: subject_map MCP tool (and the SubjectConstellationCard).
  // ============================================================================

  router.get('/admin/subject-links', authenticateAdmin, (req, res) => {
    try {
      const db = getMasterDatabase();
      const { from_type, from_id, to_type, to_id, rel } = req.query;
      const direction = req.query.direction || 'any'; // 'from' | 'to' | 'any'
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
      const clauses = [];
      const params = [];
      if (from_type && from_id && (direction === 'from' || direction === 'any')) {
        clauses.push('(from_type = ? AND from_id = ?)');
        params.push(from_type, from_id);
      }
      if (to_type && to_id && (direction === 'to' || direction === 'any')) {
        if (clauses.length) {
          clauses[clauses.length - 1] = '(' + clauses[clauses.length - 1] + ' OR (to_type = ? AND to_id = ?))';
        } else {
          clauses.push('(to_type = ? AND to_id = ?)');
        }
        params.push(to_type, to_id);
      }
      // If only one side given, simplify.
      if (clauses.length === 0 && from_type && from_id) {
        clauses.push('(from_type = ? AND from_id = ?)');
        params.push(from_type, from_id);
      }
      if (clauses.length === 0 && to_type && to_id) {
        clauses.push('(to_type = ? AND to_id = ?)');
        params.push(to_type, to_id);
      }
      if (rel) { clauses.push('rel = ?'); params.push(rel); }
      const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT id, from_type, from_id, to_type, to_id, rel, source, meta, created_at
           FROM subject_links${where}
          ORDER BY created_at DESC
          LIMIT ?`
      ).all(...params, limit).map(r => ({
        ...r,
        meta: r.meta ? safeJSON(r.meta) : null,
      }));
      res.json({ links: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/admin/subject-links', authenticateAdmin, (req, res) => {
    try {
      const { from_type, from_id, to_type, to_id, rel, source = 'manual', meta = null } = req.body || {};
      if (!from_type || !from_id || !to_type || !to_id || !rel) {
        return res.status(400).json({ error: 'from_type, from_id, to_type, to_id, rel required' });
      }
      const db = getMasterDatabase();
      // INSERT OR IGNORE so duplicate edges from idempotent webhooks don't
      // pile up — the UNIQUE constraint catches them, we surface the
      // existing row's id either way.
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO subject_links (from_type, from_id, to_type, to_id, rel, source, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      stmt.run(from_type, from_id, to_type, to_id, rel, source, meta ? JSON.stringify(meta) : null);
      const row = db.prepare(
        `SELECT id FROM subject_links
          WHERE from_type=? AND from_id=? AND to_type=? AND to_id=? AND rel=?`
      ).get(from_type, from_id, to_type, to_id, rel);
      res.json({ id: row?.id, from_type, from_id, to_type, to_id, rel });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/admin/subject-links/:id', authenticateAdmin, (req, res) => {
    try {
      const db = getMasterDatabase();
      const r = db.prepare('DELETE FROM subject_links WHERE id = ?').run(req.params.id);
      if (r.changes === 0) return res.status(404).json({ error: 'not found' });
      res.json({ deleted: Number(req.params.id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================================
  // ONBOARDING ADMIN — Shelly-callable endpoints for project + member creation.
  //
  // The originals (POST /projects/wizard, /api/team/members) are project-keyed,
  // which means Shelly (admin-keyed only) can't call them today. These admin
  // twins wrap the same logic so the chat's onboarding capabilities work end
  // to end without Franck having to think about which API key to plumb.
  // ============================================================================

  // Admin twin of /projects/wizard. Same body, same response, no project-key
  // requirement. Plane create/link logic identical.
  router.post('/admin/projects/create', authenticateAdmin, async (req, res) => {
    try {
      const { github_url = '', plane_mode = 'skip', plane_project_id = null,
              plane_name = null, name_override = null, description = null } = req.body || {};
      const m = String(github_url).match(/(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s#?.]+)/);
      if (!m) return res.status(400).json({ error: 'need a valid github.com URL' });
      const owner = m[1];
      const repo  = m[2].replace(/\.git$/, '');
      const name  = (name_override || repo).replace(/[^a-zA-Z0-9._-]/g, '-');
      if (getProjectByName(name)) {
        return res.status(409).json({ error: `Project "${name}" already exists`, existing_name: name });
      }
      let resolved_plane_id = null;
      let resolved_plane_slug = process.env.PLANE_WORKSPACE_SLUG || 'devpanl';
      if (plane_mode === 'link') {
        if (!plane_project_id) return res.status(400).json({ error: 'plane_mode=link requires plane_project_id' });
        resolved_plane_id = plane_project_id;
      } else if (plane_mode === 'create') {
        const base = (process.env.PLANE_BASE_URL || 'https://plane.devpanl.dev').replace(/\/$/, '');
        const key = process.env.PLANE_API_KEY;
        if (!key) return res.status(500).json({ error: 'PLANE_API_KEY not set on server' });
        try {
          const r = await fetch(
            `${base}/api/v1/workspaces/${resolved_plane_slug}/projects/`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
              body: JSON.stringify({
                name: plane_name || repo,
                identifier: (plane_name || repo).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || 'PROJ',
                network: 2,
              }),
            }
          );
          if (!r.ok) {
            const body = await r.text();
            return res.status(502).json({ error: `Plane create failed: ${r.status}`, body: body.slice(0, 400) });
          }
          const plane = await r.json();
          resolved_plane_id = plane.id;
        } catch (e) {
          return res.status(502).json({ error: `Plane create threw: ${e.message}` });
        }
      }
      const created = createProject({
        name, description,
        github_owner: owner, github_repo: repo,
        github_token: process.env.GITHUB_TOKEN || null,
        plane_project_id: resolved_plane_id,
        plane_workspace_slug: resolved_plane_id ? resolved_plane_slug : null,
        default_branch: 'main',
      });
      initProjectDatabase(storagePath, created.id);
      const row = getProjectById(created.id);
      res.status(201).json({
        project: row,
        plane_project_id: resolved_plane_id,
      });
    } catch (err) {
      console.error('[/admin/projects/create]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Studio members CRUD — admin-keyed twins of the project-keyed /team/members.
  router.get('/admin/studio-members', authenticateAdmin, async (req, res) => {
    try {
      const mod = await import('./studio-members.js');
      res.json({ members: await mod.listMembers() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/admin/studio-members', authenticateAdmin, async (req, res) => {
    try {
      const mod = await import('./studio-members.js');
      const row = await mod.upsertMember(req.body || {});
      res.status(201).json({ member: row });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.delete('/admin/studio-members/:tg_user_id', authenticateAdmin, async (req, res) => {
    try {
      const mod = await import('./studio-members.js');
      await mod.removeMember(req.params.tg_user_id);
      res.json({ deleted: req.params.tg_user_id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ============================================================================
  // PROJECT WIZARD — frictionless add for Franck. Project-key auth (not admin):
  // if you're logged in with a valid key you can add another project. Pastes
  // a GitHub URL, optionally links/creates a Plane project, returns a fresh
  // devpanel project + api_key.
  // ============================================================================

  router.post('/projects/wizard', authenticateProject, async (req, res) => {
    try {
      const { github_url = '', plane_mode = 'skip', plane_project_id = null,
              plane_name = null, name_override = null, description = null } = req.body || {};

      // Parse GitHub URL
      const m = String(github_url).match(/(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s#?.]+)/);
      if (!m) return res.status(400).json({ error: 'need a valid github.com URL' });
      const owner = m[1];
      const repo  = m[2].replace(/\.git$/, '');
      const name  = (name_override || repo).replace(/[^a-zA-Z0-9._-]/g, '-');

      if (getProjectByName(name)) {
        return res.status(409).json({ error: `Project "${name}" already exists`, existing_name: name });
      }

      // Plane wiring
      let resolved_plane_id = null;
      let resolved_plane_slug = process.env.PLANE_WORKSPACE_SLUG || 'devpanl';
      if (plane_mode === 'link') {
        if (!plane_project_id) return res.status(400).json({ error: 'plane_mode=link requires plane_project_id' });
        resolved_plane_id = plane_project_id;
      } else if (plane_mode === 'create') {
        const base = (process.env.PLANE_BASE_URL || 'https://plane.devpanl.dev').replace(/\/$/, '');
        const key = process.env.PLANE_API_KEY;
        if (!key) return res.status(500).json({ error: 'PLANE_API_KEY not set on server' });
        try {
          const r = await fetch(
            `${base}/api/v1/workspaces/${resolved_plane_slug}/projects/`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
              body: JSON.stringify({
                name: plane_name || repo,
                identifier: (plane_name || repo).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || 'PROJ',
                network: 2
              })
            }
          );
          if (!r.ok) {
            const body = await r.text();
            return res.status(502).json({ error: `Plane create failed: ${r.status}`, body: body.slice(0, 400) });
          }
          const plane = await r.json();
          resolved_plane_id = plane.id;
        } catch (e) {
          return res.status(502).json({ error: `Plane create threw: ${e.message}` });
        }
      }

      // Create the devpanel project
      const created = createProject({
        name,
        description,
        github_owner: owner, github_repo: repo,
        github_token: process.env.GITHUB_TOKEN || null,
        plane_project_id: resolved_plane_id,
        plane_workspace_slug: resolved_plane_id ? resolved_plane_slug : null,
        default_branch: 'main'
      });
      initProjectDatabase(storagePath, created.id);

      const row = getProjectById(created.id);
      res.status(201).json({
        project: row,
        next_steps: {
          rc_snippet: {
            plane: { project_id: resolved_plane_id || '__SET_ME__', workspace_slug: resolved_plane_slug },
            github: { repo: `${owner}/${repo}`, default_branch: 'main' }
          },
          run_in_project: '/devpanl:init'
        }
      });
    } catch (err) {
      console.error('[/projects/wizard]', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/projects', authLimiter, authenticateAdmin, async (req, res) => {
    try {
      const {
        name, description = null,
        github_owner = null, github_repo = null, github_token = null,
        plane_project_id = null, plane_workspace_slug = null,
        default_branch = null, local_path = null
      } = req.body || {};

      if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
        return res.status(400).json({ error: 'name required: alphanumeric, dot, underscore, dash' });
      }
      if (getProjectByName(name)) {
        return res.status(409).json({ error: `Project "${name}" already exists` });
      }

      const project = createProject({
        name, description,
        github_owner, github_repo, github_token,
        plane_project_id, plane_workspace_slug,
        default_branch, local_path
      });
      initProjectDatabase(storagePath, project.id);

      // Return the fresh row including api_key so the dashboard can persist it.
      const row = getProjectById(project.id);
      res.status(201).json({ ...row });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/projects/:id', authLimiter, authenticateAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const project = getProjectById(id);
      if (!project) return res.status(404).json({ error: 'project not found' });

      // Whitelist editable fields — never let api_key/id/timestamps drift in.
      const allowed = [
        'name', 'description', 'github_owner', 'github_repo', 'github_token',
        'plane_project_id', 'plane_workspace_slug', 'default_branch', 'local_path'
      ];
      const updates = {};
      for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
      if (!Object.keys(updates).length) {
        return res.status(400).json({ error: 'no editable fields in body' });
      }
      updateProject(id, updates);
      res.json(getProjectById(id));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/projects/:id', authLimiter, authenticateAdmin, (req, res) => {
    try {
      const { id } = req.params;
      const project = getProjectById(id);
      if (!project) return res.status(404).json({ error: 'project not found' });
      deleteProject(id);
      res.json({ deleted: id, name: project.name });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================================
  // CAPTURES — Franck+Shelly's triage surface. Pre-Plane queue.
  //   POST /captures                 create (content, optional kind)
  //   GET  /captures                 list for the current project
  //   GET  /captures/:id             capture + messages (thread)
  //   PATCH /captures/:id            mutate status / attach plane ids
  //   DELETE /captures/:id           drop
  // All project-key auth — captures belong to a project.
  // Note: messages are appended via POST /threads/capture/:id/messages (generic thread endpoint).
  // ============================================================================

  router.post('/captures', authenticateProject, async (req, res) => {
    try {
      const { content = '', kind = 'idea', reporter, environment, category } = req.body || {};
      if (!String(content).trim()) return res.status(400).json({ error: 'content required' });
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
      // Widget security pipeline: rate-limit, PII redaction, audit log.
      const sec = applyWidgetSecurity({
        project_id: req.project.id,
        type: AUDIT_TYPES.MESSAGE_IN,
        content: String(content).slice(0, 4000),
        req
      });
      if (!sec.ok) {
        if (sec.response.retryAfter) res.set('Retry-After', String(sec.response.retryAfter));
        return res.status(sec.response.status).json(sec.response.body);
      }
      const capture = createCapture({
        project_id: req.project.id,
        content: sec.content.slice(0, 4000),
        kind: String(kind).slice(0, 32),
        reporter: reporter ?? null,
        environment: env
      });
      // capture_created audit row — confirms the redacted content actually
      // landed in the captures table. Hash matches sec.content.
      try {
        auditEvent({
          project_id: req.project.id,
          session_id: sec.session_id,
          type: AUDIT_TYPES.CAPTURE_CREATED,
          content: sec.content
        });
      } catch (e) {
        console.error('[widget-security] audit capture_created failed:', e.message);
      }
      // If the widget submitted a category, pre-write routed_label (no member
      // resolution yet — Shelly will call /captures/:id/route to do that).
      if (category && typeof category === 'string' && category.trim()) {
        setCaptureRouting(capture.id, { label: category.trim(), member_id: null });
      }
      // Both notifyCaptureNew and autorouteCapture fire from the capture's
      // system-message handler (POST /threads/capture/:id/messages), not
      // here. At this point the widget hasn't yet posted the system message
      // that carries metadata.screenshot/url — so a notify here would be
      // text-only (Franck wants the screenshot inline) and autoroute couldn't
      // classify by URL pattern. Routing + image broadcast happen the moment
      // the system message lands.
      // Captures created without a follow-up (e.g. from the dashboard
      // composer) won't trigger a Telegram broadcast — that's fine, the
      // dashboard Inbox already shows them.

      // Tell the dashboard's Inbox view to refetch — capture_new is a NOTIFY/QUESTION
      // signal but we don't push the whole row over SSE; the client refetches
      // /api/inbox on this event.
      broadcast('inbox:invalidate', { reason: 'capture_new', capture_id: capture.id });
      res.status(201).json(capture);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/captures', authenticateProject, (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : null;
      const reporter_id = req.query.reporter_id ? String(req.query.reporter_id) : null;
      const environment = req.query.environment ? String(req.query.environment).slice(0, 64) : null;
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
      res.json({ captures: listCaptures({ project_id: req.project.id, status, reporter_id, environment, limit }) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/captures/:id', authenticateProject, (req, res) => {
    try {
      const c = getCapture(req.params.id);
      if (!c || c.project_id !== req.project.id) return res.status(404).json({ error: 'not found' });
      res.json(c);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Back-compat shim for the @devpanel/react widget shipped in EDMS and other
  // consumer apps. Old bundles still POST here with {role, content, metadata}.
  // We write directly to the capture's thread, bypassing the Telegram forward
  // (context messages aren't worth pushing to Shelly — only the creation
  // itself gets forwarded, if ever).
  router.post('/captures/:id/messages', authenticateProject, (req, res) => {
    try {
      const c = getCapture(req.params.id);
      if (!c || c.project_id !== req.project.id) return res.status(404).json({ error: 'not found' });
      const { content, role: reqRole, metadata } = req.body || {};
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'content required' });
      }
      const ALLOWED_ROLES = new Set(['user', 'shelly', 'system', 'agent']);
      const role = reqRole || 'user';
      if (!ALLOWED_ROLES.has(role)) {
        return res.status(400).json({ error: `invalid role: ${role}` });
      }
      // Widget security pipeline. The widget sends user replies + system
      // metadata frames through this route, so it needs the same rate
      // limit / redaction / audit treatment as POST /captures.
      const sec = applyWidgetSecurity({
        project_id: req.project.id,
        type: AUDIT_TYPES.MESSAGE_IN,
        content,
        req
      });
      if (!sec.ok) {
        if (sec.response.retryAfter) res.set('Retry-After', String(sec.response.retryAfter));
        return res.status(sec.response.status).json(sec.response.body);
      }
      const thread = getOrCreateThread('capture', c.id);
      const id = appendThreadMessage({
        thread_id: thread.thread_id, role, source: 'web', content: sec.content,
        metadata: metadata ?? null
      });
      res.json({ id, thread_id: thread.thread_id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.patch('/captures/:id', authenticateProject, (req, res) => {
    try {
      const c = getCapture(req.params.id);
      if (!c || c.project_id !== req.project.id) return res.status(404).json({ error: 'not found' });
      res.json(updateCapture(req.params.id, req.body || {}));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/captures/:id', authenticateProject, (req, res) => {
    try {
      const c = getCapture(req.params.id);
      if (!c || c.project_id !== req.project.id) return res.status(404).json({ error: 'not found' });
      deleteCapture(c.id);
      res.json({ deleted: c.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/captures/:id/route', authenticateProject, async (req, res) => {
    try {
      const { label } = req.body || {};
      if (!label || typeof label !== 'string' || !label.trim()) {
        return res.status(400).json({ error: 'label required' });
      }
      let result;
      try {
        result = await routeCapture(req.params.id, label.trim());
      } catch (e) {
        if (e.message && e.message.includes('not found')) return res.status(404).json({ error: e.message });
        throw e;
      }
      if (result === null) return res.status(409).json({ error: 'no member for that label' });
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ============================================================================
  // TEAM & ROUTING — manage project members and label→member routing rules.
  // ============================================================================
  defineTeamRoutes(router, authenticateProject);
  defineInboxRoutes(router, authenticateProject);
  defineMemoryRoutes(router, authenticateProject);
  defineFleetRoutes(router, authenticateProject, authenticateAdmin, authenticateSpaBootstrap);
  defineCommandRoutes(router, authenticateProject);
  defineWidgetRoutes(router);
  defineWidgetBridgeRoutes(router, authenticateProject);

  // ============================================================================
  // TRANSCRIPT RECENT — last N minutes of Shelly's verbatim Telegram log.
  // Powers the dashboard's fleet-live phone-mirror panel: the user wants
  // to see the same conversation Telegram shows, without leaving the
  // dashboard. Project-keyed because it's UI-bound, not admin tooling.
  // ============================================================================
  router.get('/transcript/recent', authenticateProject, async (req, res) => {
    const minutes = Math.max(5, Math.min(1440, parseInt(req.query.minutes, 10) || 240));
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    try {
      const { transcriptRange } = await import('./pg.js');
      const rows = await transcriptRange({ since, limit });
      // Reverse so callers can render in chronological order without sorting.
      const messages = rows.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts)).map(r => ({
        id: r.id,
        created_at: r.ts,
        bot_label: r.bot_label,
        direction: r.direction,
        role: r.role,
        thread_subject: r.thread_subject,
        content: r.content,
      }));
      res.json({ messages });
    } catch (e) {
      console.warn('[transcript/recent]', e.message);
      res.json({ messages: [], degraded: true, error: e.message });
    }
  });

  // ============================================================================
  // TODAY VIEW — single actionable feed across the whole team.
  // Aggregates from three sources: workflow_instances (engine state),
  // BullMQ agents queue (job-level failures), and per-project tickets.
  // Project key auth (read-only metrics, nothing destructive).
  // ============================================================================

  router.get('/today', authenticateProject, async (req, res) => {
    try {
      const now = Date.now();
      const dayAgo = now - 24 * 3600 * 1000;
      const ageMin = (ts) => Math.max(0, Math.round((now - ts) / 60000));

      // Workflow instances — full picture from the engine. Reads from shared
      // Postgres (migration 003 moved orchestration there). Until 2026-04-28
      // this read from SQLite workflow_instances which the worker stopped
      // writing to weeks ago — that's why Today showed IN PROGRESS=0 even
      // when 8+ workflows were running on Zeno.
      let allInstances = [];
      try {
        const r = await pgPool.query(
          `SELECT id, work_item_id, workflow_name, revision, current_step, status,
                  started_at, last_event_at, exhausted_at, last_job_id, metadata
             FROM workflow_instances
             ORDER BY last_event_at DESC NULLS LAST
             LIMIT 200`
        );
        allInstances = r.rows;
      } catch (e) {
        console.warn('[/today] pg workflow_instances unreachable:', e.message);
      }

      const parseMeta = (m) => {
        if (!m) return null;
        if (typeof m !== 'string') return m; // pg JSONB already parsed
        try { return JSON.parse(m); } catch { return null; }
      };
      // BIGINT epoch ms comes back as string from node-postgres — coerce.
      const asNum = (v) => {
        if (v == null) return 0;
        if (typeof v === 'number') return v;
        const n = parseInt(String(v).trim(), 10);
        return Number.isFinite(n) ? n : 0;
      };

      const needs_attention = [];
      const in_progress = [];
      const shipped_today = [];

      for (const inst of allInstances) {
        const meta = parseMeta(inst.metadata);
        const lastEvtMs = asNum(inst.last_event_at);
        const base = {
          instance_id: inst.id,
          work_item_id: inst.work_item_id,
          workflow: inst.workflow_name,
          step: inst.current_step,
          revision: inst.revision,
          status: inst.status,
          age_min: ageMin(lastEvtMs),
          last_event_at: lastEvtMs,
          metadata: meta
        };
        if (inst.status === 'exhausted' || inst.status === 'awaiting_approval') {
          needs_attention.push({ kind: `workflow_${inst.status}`, ...base });
        } else if (inst.status === 'running') {
          in_progress.push({ kind: 'workflow_running', ...base });
        } else if (inst.status === 'done' && lastEvtMs >= dayAgo) {
          shipped_today.push({ kind: 'workflow_done', ...base });
        }
      }

      // Failed BullMQ jobs — DLQ-flavoured surface for things that didn't
      // even reach a workflow terminal (e.g. claude -p crashed mid-run).
      let recent_failed_jobs = [];
      try {
        const queue = getQueue(QUEUES.agents);
        const failed = await queue.getJobs(['failed'], 0, 19);
        recent_failed_jobs = failed
          .filter(j => (j.finishedOn || j.timestamp || 0) >= dayAgo)
          .map(j => ({
            kind: 'job_failed',
            job_id: j.id,
            name: j.name,
            agent: j.data?.agent,
            work_item_id: j.data?.plane?.work_item_id,
            failed_reason: (j.failedReason || '').slice(0, 240),
            attempts: j.attemptsMade,
            age_min: ageMin(j.finishedOn || j.timestamp || now)
          }));
      } catch { /* queue may be cold, skip silently */ }

      // 24h pulse — the team's heartbeat.
      const stats_24h = {
        ships: shipped_today.length,
        in_progress: in_progress.length,
        needs_attention: needs_attention.length + recent_failed_jobs.length,
        avg_duration_min: shipped_today.length
          ? Math.round(shipped_today.reduce((s, w) => {
              const start = w.metadata?.started_at || w.last_event_at;
              return s + Math.max(0, (w.last_event_at - start) / 60000);
            }, 0) / shipped_today.length)
          : null
      };

      // Recent activity feed (per current project) — last 30 ticket events.
      let activity = [];
      try { activity = listActivity(storagePath, req.project.id, 30) || []; }
      catch { /* tolerate cold project */ }

      res.json({
        project: { id: req.project.id, name: req.project.name },
        generated_at: new Date().toISOString(),
        stats_24h,
        needs_attention,
        recent_failed_jobs,
        in_progress,
        shipped_today,
        activity
      });
    } catch (err) {
      console.error('[/today]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Import GitHub repo as project
  router.post('/projects/import', authLimiter, authenticateAdmin, async (req, res) => {
    try {
      const { github_url, github_token } = req.body;

      if (!github_url) {
        return res.status(400).json({ error: 'Missing github_url' });
      }

      const token = github_token || process.env.GITHUB_TOKEN;
      if (!token) {
        return res.status(400).json({ error: 'Missing github_token or GITHUB_TOKEN env var' });
      }

      // Parse URL
      const match = github_url.match(/(?:https?:\/\/)?github\.com\/([^/]+)\/([^/\s#?.]+)/);
      if (!match) {
        return res.status(400).json({ error: 'Invalid GitHub URL' });
      }

      const owner = match[1];
      const repo = match[2].replace(/\.git$/, '');

      // Check existing
      const existing = getProjectByName(repo);
      if (existing) {
        return res.status(409).json({ error: `Project "${repo}" already exists`, project: existing });
      }

      // Create project
      initGitHub(token);
      const project = createProject({
        name: repo,
        github_owner: owner,
        github_repo: repo,
        github_token: token
      });

      initProjectDatabase(storagePath, project.id);

      // Import open issues
      const issues = await listIssues({ owner, repo, state: 'open' });
      const realIssues = issues.filter(i => !i.pull_request);

      let imported = 0;
      for (const issue of realIssues) {
        const type = issue.labels.some(l =>
          ['bug', 'fix', 'defect'].includes(l.name.toLowerCase())
        ) ? 'bug' : 'feature';

        const ticketId = createTicket(storagePath, project.id, {
          type,
          title: issue.title,
          description: issue.body || '(no description)',
          context: {
            github_url: issue.html_url,
            labels: issue.labels.map(l => l.name),
            author: issue.user?.login
          },
          created_by: issue.user?.login
        });

        const db = getProjectDatabase(storagePath, project.id);
        db.prepare(`
          UPDATE tickets SET
            github_issue_number = ?,
            github_issue_url = ?,
            github_status = ?,
            status = 'published'
          WHERE id = ?
        `).run(issue.number, issue.html_url, issue.state, ticketId);

        imported++;
      }

      // Import milestones
      const milestones = await fetchMilestones({ owner, repo });
      for (const m of milestones) {
        upsertMilestone(storagePath, project.id, m);
      }

      res.status(201).json({
        project,
        imported_issues: imported,
        imported_milestones: milestones.length,
        github: `${owner}/${repo}`
      });
    } catch (error) {
      console.error('Error importing project:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================================
  // PROJECT-SCOPED ENDPOINTS (API Key required)
  // ============================================================================

  // List pending clarifications
  router.get('/clarifications', authenticateProject, (req, res) => {
    try {
      const pending = listPendingClarifications(storagePath, req.project.id);
      res.json({ project: req.project.name, clarifications: pending });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Answer a clarification
  router.post('/tickets/:id/answer', authenticateProject, (req, res) => {
    try {
      const { answer, index } = req.body;
      if (!answer) {
        return res.status(400).json({ error: 'Missing answer' });
      }
      const result = answerClarification(storagePath, req.project.id, parseInt(req.params.id), index || 0, answer);
      if (!result) {
        return res.status(404).json({ error: 'Clarification not found' });
      }
      res.json({ message: 'Clarification answered', clarification: result });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Route a ticket to a team member via label resolution
  router.post('/tickets/:id/route', authenticateProject, async (req, res) => {
    const { label } = req.body ?? {};
    if (!label) return res.status(400).json({ error: 'label required' });
    try {
      const out = await routeTicket(storagePath, req.project.id, parseInt(req.params.id, 10), label);
      if (out === null) {
        return res.status(409).json({ error: `no member registered for label "${label}"` });
      }
      res.json(out);
    } catch (err) {
      if (/not found/i.test(err.message)) return res.status(404).json({ error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // List milestones
  router.get('/milestones', authenticateProject, (req, res) => {
    try {
      const { state } = req.query;
      const ms = listMilestones(storagePath, req.project.id, { state });
      res.json({ project: req.project.name, milestones: ms });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Search docs (full-text)
  router.get('/docs/search', authenticateProject, (req, res) => {
    try {
      const { q, limit } = req.query;
      if (!q) {
        return res.status(400).json({ error: 'Missing query parameter: q' });
      }
      const results = searchDocs(storagePath, req.project.id, q, limit ? parseInt(limit) : 10);
      res.json({ project: req.project.name, query: q, results });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // List docs
  router.get('/docs', authenticateProject, (req, res) => {
    try {
      const docs = listDocs(storagePath, req.project.id);
      const stats = getDocStats(storagePath, req.project.id);
      res.json({ project: req.project.name, count: stats.count, docs });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Sync docs from GitHub
  router.post('/docs/sync', authenticateProject, async (req, res) => {
    try {
      const project = req.project;
      if (!project.github_token) {
        return res.status(400).json({ error: 'No GitHub token configured for this project' });
      }

      initGitHub(project.github_token);
      const remoteDocs = await fetchRepoDocs({
        owner: project.github_owner,
        repo: project.github_repo
      });

      let synced = 0;
      for (const doc of remoteDocs) {
        upsertDoc(storagePath, project.id, doc);
        synced++;
      }

      res.json({ project: project.name, synced });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Create ticket
  router.post('/tickets', ticketCreateLimiter, authenticateProject, async (req, res) => {
    try {
      const { type, title, description, context, screenshot, created_by, category } = req.body;

      if (!type || !title || !description) {
        return res.status(400).json({ error: 'Missing required fields: type, title, description' });
      }

      // Handle base64 screenshot
      let screenshotBuffer = null;
      let screenshotMimeType = null;

      if (screenshot) {
        // Extract base64 data and mime type
        const matches = screenshot.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          screenshotMimeType = matches[1];
          screenshotBuffer = Buffer.from(matches[2], 'base64');
        }
      }

      const ticketId = createTicket(storagePath, req.project.id, {
        type,
        title,
        description,
        context,
        screenshot: screenshotBuffer,
        screenshot_mime_type: screenshotMimeType,
        created_by
      });

      logActivity(storagePath, req.project.id, {
        action: 'created',
        ticketId,
        detail: `${type}: ${title}`,
      });
      broadcast('ticket:created', { id: ticketId, type, title });
      notifyTicket({ id: ticketId, type, title, project: req.project.name, created_by });

      // If the user picked a category in the widget, persist it as routed_label up
      // front. Shelly will skip classification and call route_ticket directly.
      if (category) {
        setTicketRouting(storagePath, req.project.id, ticketId, { label: category, member_id: null });
      }

      notifyTicketNew({
        project: req.project.name,
        ticket_id: ticketId,
        category: category || '',
        title
      });

      res.status(201).json({
        id: ticketId,
        message: 'Ticket created successfully',
        project: req.project.name
      });
    } catch (error) {
      console.error('Error creating ticket:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get ticket details
  router.get('/tickets/:id', authenticateProject, (req, res) => {
    try {
      const ticket = getTicket(storagePath, req.project.id, parseInt(req.params.id));

      if (!ticket) {
        return res.status(404).json({ error: 'Ticket not found' });
      }

      // Don't send screenshot BLOB in JSON response
      const { screenshot, ...ticketWithoutBlob } = ticket;
      ticketWithoutBlob.has_screenshot = !!screenshot;

      res.json(ticketWithoutBlob);
    } catch (error) {
      console.error('Error getting ticket:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // List tickets
  router.get('/tickets', authenticateProject, (req, res) => {
    try {
      const { status, limit } = req.query;

      const tickets = listTickets(storagePath, req.project.id, {
        status,
        limit: limit ? parseInt(limit) : undefined
      });

      res.json({
        project: req.project.name,
        tickets
      });
    } catch (error) {
      console.error('Error listing tickets:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get screenshot
  router.get('/tickets/:id/screenshot', authenticateProject, (req, res) => {
    try {
      const ticket = getTicket(storagePath, req.project.id, parseInt(req.params.id));

      if (!ticket) {
        return res.status(404).json({ error: 'Ticket not found' });
      }

      if (!ticket.screenshot) {
        return res.status(404).json({ error: 'No screenshot for this ticket' });
      }

      // Send BLOB as image
      res.set('Content-Type', ticket.screenshot_mime_type || 'image/png');
      res.send(ticket.screenshot);
    } catch (error) {
      console.error('Error getting screenshot:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Update ticket
  router.patch('/tickets/:id', authenticateProject, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;

      // Add timestamp for certain status changes
      if (updates.status === 'published' && !updates.reviewed_at) {
        updates.reviewed_at = new Date().toISOString();
      }

      updateTicket(storagePath, req.project.id, id, updates);

      res.json({ message: 'Ticket updated successfully' });
    } catch (error) {
      console.error('Error updating ticket:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Delete/reject ticket
  router.delete('/tickets/:id', authenticateProject, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { reason } = req.body;

      if (reason) {
        // Soft delete: mark as rejected
        updateTicket(storagePath, req.project.id, id, {
          status: 'rejected',
          rejection_reason: reason,
          reviewed_at: new Date().toISOString()
        });
      } else {
        // Hard delete
        deleteTicket(storagePath, req.project.id, id);
      }

      res.json({ message: 'Ticket deleted successfully' });
    } catch (error) {
      console.error('Error deleting ticket:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get stats
  router.get('/stats', authenticateProject, (req, res) => {
    try {
      const stats = getStats(storagePath, req.project.id);

      res.json({
        project: req.project.name,
        stats
      });
    } catch (error) {
      console.error('Error getting stats:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Activity feed
  router.get('/activity', authenticateProject, (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const activity = listActivity(storagePath, req.project.id, limit);
      res.json(activity);
    } catch (error) {
      console.error('Error listing activity:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================================
  // TICKET MESSAGES (conversation thread)
  // ============================================================================

  // List messages for a ticket
  router.get('/tickets/:id/messages', authenticateProject, (req, res) => {
    try {
      const messages = listMessages(storagePath, req.project.id, parseInt(req.params.id));
      res.json({ ticket_id: parseInt(req.params.id), messages });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Post a message to a ticket thread
  router.post('/tickets/:id/messages', authenticateProject, (req, res) => {
    try {
      const { role, author, content } = req.body;
      if (!content) {
        return res.status(400).json({ error: 'Missing required field: content' });
      }
      if (!role || !['user', 'agent', 'admin', 'system'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role. Must be: user, agent, admin, system' });
      }

      const ticket = getTicket(storagePath, req.project.id, parseInt(req.params.id));
      if (!ticket) {
        return res.status(404).json({ error: 'Ticket not found' });
      }

      const message = addMessage(storagePath, req.project.id, parseInt(req.params.id), {
        role,
        author: author || null,
        content
      });

      broadcast('message:created', {
        ticket_id: parseInt(req.params.id),
        message
      });

      res.status(201).json(message);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // SSE events stream
  router.get('/events', authenticateProject, (req, res) => {
    addClient(res);
  });

  // Publish ticket to GitHub
  router.post('/tickets/:id/publish', authenticateProject, async (req, res) => {
    try {
      const ticketId = parseInt(req.params.id);
      const { title, labels, assignee } = req.body;
      const fs = await import('fs');
      let githubConfig = {};
      try {
        const config = JSON.parse(fs.readFileSync('.devpanelrc.json', 'utf-8'));
        githubConfig = config.github || {};
      } catch (e) {
        // No config file, rely on env vars
      }
      const issue = await publishTicket(storagePath, req.project.id, ticketId, {
        githubConfig,
        title,
        labels,
        assignee,
      });
      res.json({ message: 'Ticket published', issue: { number: issue.number, url: issue.html_url } });
    } catch (error) {
      console.error('Error publishing ticket:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Reject ticket
  router.post('/tickets/:id/reject', authenticateProject, (req, res) => {
    try {
      const ticketId = parseInt(req.params.id);
      const { reason } = req.body;
      const result = rejectTicket(storagePath, req.project.id, ticketId, reason);
      res.json(result);
    } catch (error) {
      console.error('Error rejecting ticket:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Sync GitHub comments into message thread
  router.post('/tickets/:id/sync-comments', authenticateProject, async (req, res) => {
    try {
      const ticketId = parseInt(req.params.id);
      const ticket = getTicket(storagePath, req.project.id, ticketId);
      if (!ticket) {
        return res.status(404).json({ error: 'Ticket not found' });
      }
      if (!ticket.github_issue_number) {
        return res.status(400).json({ error: 'Ticket has no linked GitHub issue' });
      }

      const project = req.project;
      if (!project.github_token) {
        return res.status(400).json({ error: 'No GitHub token configured' });
      }

      initGitHub(project.github_token);
      const comments = await fetchIssueComments({
        owner: project.github_owner,
        repo: project.github_repo,
        issue_number: ticket.github_issue_number
      });

      const { getMessageByGithubCommentId } = await import('./db.js');
      let synced = 0;
      for (const comment of comments) {
        const existing = getMessageByGithubCommentId(storagePath, project.id, comment.id);
        if (!existing) {
          addMessage(storagePath, project.id, ticketId, {
            role: 'system',
            author: comment.author,
            content: comment.body,
            github_comment_id: comment.id
          });
          synced++;
        }
      }

      res.json({ synced, total_comments: comments.length });
    } catch (error) {
      console.error('Error syncing comments:', error);
      res.status(500).json({ error: error.message });
    }
  });


  // ============================================================================
  // Admin SSE — used by the worker to stream job lifecycle events
  // ============================================================================

  function authenticateAdmin(req, res, next) {
    // Fallback: EventSource cannot set headers. Accept ?key= for GETs ONLY so
    // state-changing requests (POST/PATCH/DELETE) still require a header.
    const key = req.headers['x-admin-key'] || (req.method === 'GET' ? req.query?.key : null);
    const expected = process.env.ADMIN_API_KEY;
    if (!key || !expected || key.length !== expected.length ||
        !timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
      return res.status(401).json({ error: 'admin auth required' });
    }
    next();
  }

  router.get('/admin/events', authenticateAdmin, (req, res) => {
    import('./sse.js').then(({ addAdminClient }) => addAdminClient(res));
  });

  router.post('/admin/events/publish', authenticateAdmin, express.json(), async (req, res) => {
    const { event, data } = req.body || {};
    if (!event || typeof event !== 'string') return res.status(400).json({ error: 'event required' });
    const { broadcastAdmin } = await import('./sse.js');
    broadcastAdmin(event, data || {});
    res.json({ ok: true });
  });

  // Per-job agent event timeline. ?after=<seq> for incremental fetch,
  // ?stream=1 turns the request into an SSE tail-follow. Backed by
  // agent_job_events, which is populated as claude -p emits stream-json.
  // Auth flexibility: admin key (header or ?key= for EventSource), OR SSO
  // session (X-Forwarded-User from oauth2-proxy / dashboard bypass) — the
  // dashboard streams logs without an admin key.
  router.get('/admin/jobs/:id/events', authenticateSpaBootstrap, async (req, res) => {
    const id = String(req.params.id);
    const isStream = req.query.stream === '1';
    const after = Number.isFinite(parseInt(req.query.after, 10)) ? parseInt(req.query.after, 10) : -1;
    const limit = Math.min(50000, Math.max(1, parseInt(req.query.limit, 10) || 10000));

    // Try local Postgres first.
    let useProd = false;
    let listEvents, subscribe;
    try {
      ({ listEvents, subscribe } = await import('./jobs-events.js'));
      // Quick liveness probe — if Pg is down, listEvents will throw.
      await listEvents(id, { after: -1, limit: 1 });
    } catch (err) {
      const base = process.env.PROD_API_BASE;
      const key = process.env.ADMIN_API_KEY;
      useProd = Boolean(base && key);
      if (!useProd) {
        if (isStream) {
          res.status(503).type('text/event-stream').send('');
        } else {
          res.status(503).json({ error: 'pg unavailable, no prod fallback', detail: err.message });
        }
        return;
      }
    }

    if (useProd) {
      // Proxy to prod. For SSE, stream the upstream body verbatim. For JSON,
      // forward the response. Prod accepts ?key= for GETs, so EventSource works.
      const base = process.env.PROD_API_BASE.replace(/\/$/, '');
      const key = process.env.ADMIN_API_KEY;
      const qs = new URLSearchParams();
      if (isStream) qs.set('stream', '1');
      if (after >= 0) qs.set('after', String(after));
      if (!isStream && limit) qs.set('limit', String(limit));
      qs.set('key', key);
      const upstream = await fetch(`${base}/api/admin/jobs/${encodeURIComponent(id)}/events?${qs}`, {
        headers: { 'X-Admin-Key': key, 'Accept': isStream ? 'text/event-stream' : 'application/json' },
      }).catch((e) => ({ ok: false, statusText: e.message, status: 502 }));
      if (!upstream.ok) {
        const body = upstream.text ? await upstream.text().catch(() => '') : '';
        if (isStream) {
          res.status(upstream.status || 502).type('text/event-stream').send('');
        } else {
          res.status(upstream.status || 502).json({ error: 'prod proxy failed', detail: body });
        }
        return;
      }
      if (isStream) {
        res.status(200).set({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
        });
        res.flushHeaders?.();
        const reader = upstream.body.getReader();
        req.on('close', () => reader.cancel().catch(() => {}));
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      } else {
        res.status(200).type('application/json').send(await upstream.text());
      }
      return;
    }

    // Local Pg path.
    if (isStream) {
      subscribe(id, res);
      const past = await listEvents(id, { after });
      for (const ev of past) {
        res.write(`event: job_event\ndata: ${JSON.stringify({ job_id: id, ...ev })}\n\n`);
      }
      return;
    }
    res.json({ job_id: id, events: await listEvents(id, { after, limit }) });
  });

  router.get('/admin/jobs/:id/stderr', authenticateAdmin, async (req, res) => {
    const { readFileSync, existsSync } = await import('fs');
    const { join } = await import('path');
    const path = join(process.env.DEVPANEL_STORAGE || './storage', 'agent-logs', `${req.params.id}.err.log`);
    if (!existsSync(path)) return res.status(404).type('text/plain').send('');
    res.type('text/plain').send(readFileSync(path, 'utf8'));
  });

  // Untagged Telegram inbound (was silently dropped by the MCP before).
  // The MCP posts here so Franck can see what Shelly received but didn't route.
  router.post('/admin/telegram-drops', authenticateAdmin, express.json(), (req, res) => {
    try {
      const { raw_text, role, telegram_message_id } = req.body || {};
      if (!raw_text) return res.status(400).json({ error: 'raw_text required' });
      const db = getMasterDatabase();
      const info = db.prepare(
        `INSERT INTO telegram_drops (raw_text, role, telegram_message_id, reason)
         VALUES (?, ?, ?, 'no_tag')`
      ).run(raw_text, role ?? null, telegram_message_id ?? null);
      res.json({ id: info.lastInsertRowid });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/admin/telegram-drops', authenticateAdmin, (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const db = getMasterDatabase();
    const rows = db.prepare(
      `SELECT id, raw_text, role, telegram_message_id, reason, created_at
       FROM telegram_drops ORDER BY id DESC LIMIT ?`
    ).all(limit);
    res.json({ drops: rows });
  });

  // Recent outbound Telegram forward attempts + their delivery status.
  router.get('/admin/telegram-outbound', authenticateAdmin, (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const status = req.query.status;
    const db = getMasterDatabase();
    const rows = status
      ? db.prepare(
          `SELECT id, thread_message_id, subject_type, subject_id, text, transport, status, error, attempts, created_at, delivered_at
           FROM telegram_outbound WHERE status = ? ORDER BY id DESC LIMIT ?`
        ).all(status, limit)
      : db.prepare(
          `SELECT id, thread_message_id, subject_type, subject_id, text, transport, status, error, attempts, created_at, delivered_at
           FROM telegram_outbound ORDER BY id DESC LIMIT ?`
        ).all(limit);
    res.json({ messages: rows });
  });

  // Work-item chain: every workflow_instance ever run against a work_item +
  // every job that executed under those instances + any PR/branch/commit
  // artifacts extracted from the job's final result event. Powers the
  // /dashboard/work-items view.
  //
  // Reads from shared Postgres (single source of truth — orchestration moved
  // there in migration 003) and enriches each row with Plane metadata
  // (title, sequence_id, project, state, priority) so the PM can read the
  // list as humans, not UUIDs.
  router.get('/admin/work-items', authenticateAdmin, async (req, res) => {
    try {
      const { rows } = await pgPool.query(`
        SELECT
          work_item_id,
          COUNT(*)::int AS instances,
          SUM(CASE WHEN status='done' THEN 1 ELSE 0 END)::int AS done,
          SUM(CASE WHEN status IN ('failed','blocked','exhausted') THEN 1 ELSE 0 END)::int AS failed,
          SUM(CASE WHEN status IN ('running','awaiting_approval') THEN 1 ELSE 0 END)::int AS active,
          MAX(last_event_at) AS last_event_at,
          string_agg(DISTINCT workflow_name, ',') AS workflows,
          (array_agg(current_step ORDER BY last_event_at DESC))[1] AS latest_step,
          (array_agg(status        ORDER BY last_event_at DESC))[1] AS latest_status,
          (array_agg(last_job_id   ORDER BY last_event_at DESC))[1] AS latest_job_id
        FROM workflow_instances
        GROUP BY work_item_id
        ORDER BY MAX(last_event_at) DESC
      `);

      const uuids = rows.map(r => r.work_item_id);
      const meta = await enrichWorkItems(uuids);

      const enriched = rows.map(r => {
        const m = meta.get(r.work_item_id) || {};
        return {
          ...r,
          title: m.title || null,
          sequence_id: m.sequence_id || null,
          identifier: m.identifier || null,
          project_id: m.project_id || null,
          project_name: m.project_name || null,
          priority: m.priority || null,
          state_name: m.state_name || null,
          state_group: m.state_group || null,
          state_color: m.state_color || null,
          plane_url: m.plane_url || null,
          completed_at: m.completed_at || null
        };
      });
      res.json({ work_items: enriched });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/admin/work-items/:id', authenticateAdmin, async (req, res) => {
    try {
      const workItemId = req.params.id;

      const { rows: instances } = await pgPool.query(
        `SELECT id, workflow_name, revision, current_step, status, started_at,
                last_event_at, exhausted_at, last_job_id, metadata
           FROM workflow_instances
          WHERE work_item_id = $1
          ORDER BY started_at ASC`,
        [workItemId]
      );

      const jobIds = instances.map(i => i.last_job_id).filter(Boolean);

      const { rows: extras } = await pgPool.query(
        `SELECT DISTINCT job_id FROM agent_job_events WHERE payload::text LIKE $1`,
        [`%${workItemId}%`]
      );
      const allJobIds = [...new Set([...jobIds, ...extras.map(r => r.job_id)])];

      const jobs = [];
      for (const job_id of allJobIds) {
        const { rows: steps } = await pgPool.query(
          `SELECT step, status, error, duration_ms, timestamp, agent
             FROM agent_job_log WHERE job_id = $1 ORDER BY id ASC`,
          [job_id]
        );
        const { rows: resultRows } = await pgPool.query(
          `SELECT payload FROM agent_job_events
            WHERE job_id = $1 AND event_type = 'result'
            ORDER BY seq DESC LIMIT 1`,
          [job_id]
        );
        const resultRow = resultRows[0];

        let artifacts = null;
        let status = null;
        if (resultRow) {
          try {
            const p = typeof resultRow.payload === 'string'
              ? JSON.parse(resultRow.payload) : resultRow.payload;
            const inner = typeof p.result === 'string' ? JSON.parse(p.result) : p.result;
            artifacts = inner?.artifacts || null;
            status = inner?.status || p.subtype || null;
          } catch { /* payload not JSON, skip */ }
        }

        jobs.push({
          job_id,
          agent: steps[0]?.agent || null,
          status,
          artifacts,
          step_count: steps.length,
          first_at: steps[0]?.timestamp || null,
          last_at: steps[steps.length - 1]?.timestamp || null,
          error_count: steps.filter(s => s.status === 'error').length
        });
      }
      jobs.sort((a, b) => String(a.first_at || '').localeCompare(String(b.first_at || '')));

      const meta = (await enrichWorkItems([workItemId])).get(workItemId) || {};

      res.json({
        work_item_id: workItemId,
        title: meta.title || null,
        sequence_id: meta.sequence_id || null,
        identifier: meta.identifier || null,
        project_name: meta.project_name || null,
        priority: meta.priority || null,
        state_name: meta.state_name || null,
        state_group: meta.state_group || null,
        plane_url: meta.plane_url || null,
        instances,
        jobs
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Per-agent roll-up: which agents have run, how often, success rate, last-seen.
  // Feeds /dashboard/agents. Reads from shared Postgres (migration 003 moved
  // agent_job_log out of SQLite). Until 2026-04-28 this was reading from the
  // dead SQLite table — which is why every agent showed "4d ago" no matter
  // how recently it had actually run. The worker has been writing to PG for
  // weeks, the dashboard just wasn't following.
  router.get('/admin/agents', authenticateAdmin, async (req, res) => {
    try {
      const { rows } = await pgPool.query(`
        SELECT
          agent,
          COUNT(*)::int AS total,
          SUM(CASE WHEN status='ok'    THEN 1 ELSE 0 END)::int AS ok,
          SUM(CASE WHEN status='error' THEN 1 ELSE 0 END)::int AS error,
          SUM(CASE WHEN status='stub'  THEN 1 ELSE 0 END)::int AS stub,
          SUM(CASE WHEN timestamp > now() - interval '24 hours' THEN 1 ELSE 0 END)::int AS last_24h,
          MAX(timestamp) AS last_seen,
          AVG(duration_ms)::int AS avg_duration_ms
        FROM agent_job_log
        GROUP BY agent
        ORDER BY MAX(timestamp) DESC
      `);
      res.json({ agents: rows });
    } catch (e) {
      console.error('[admin/agents]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // Per-agent recent job log. Used when you drill into one agent card.
  router.get('/admin/agents/:agent/recent', authenticateAdmin, async (req, res) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const { rows } = await pgPool.query(`
        SELECT id, job_id, step, status, error, duration_ms, timestamp
        FROM agent_job_log
        WHERE agent = $1
        ORDER BY id DESC
        LIMIT $2
      `, [req.params.agent, limit]);
      res.json({ steps: rows });
    } catch (e) {
      console.error('[admin/agents/:agent/recent]', e);
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/admin/workflows/instances', authenticateAdmin, async (req, res) => {
    const { listActive, listByCycle } = await import('./workflow-instances.js');
    const rows = req.query.cycle_id ? await listByCycle(req.query.cycle_id) : await listActive();
    res.json({ instances: rows });
  });

  router.get('/admin/workflows/instances/:id', authenticateAdmin, async (req, res) => {
    const { loadInstanceById } = await import('./workflow-instances.js');
    const { listSteps } = await import('./jobs-log.js');
    const instance = await loadInstanceById(parseInt(req.params.id, 10));
    if (!instance) return res.status(404).json({ error: 'not found' });
    const steps = instance.last_job_id ? await listSteps(instance.last_job_id) : [];
    res.json({ instance, steps });
  });

  // Operator override — force a stuck workflow_instance to a terminal state so
  // a new dispatch on the same (work_item, workflow) can proceed. Use when the
  // engine left status=running but no agent is actually working (DEVPA-174:
  // builder.completed → reviewer.enqueue silently dropped). Status MUST be one
  // of failed|exhausted; we don't accept 'completed' because that would lie
  // about the actual outcome.
  router.post('/admin/workflows/instances/:id/unstick', authenticateAdmin, async (req, res) => {
    const { loadInstanceById, updateInstance } = await import('./workflow-instances.js');
    const id = parseInt(req.params.id, 10);
    const instance = await loadInstanceById(id);
    if (!instance) return res.status(404).json({ error: 'not found' });
    const requested = (req.body?.status || 'failed').toString();
    const ALLOWED = new Set(['failed', 'exhausted']);
    if (!ALLOWED.has(requested)) {
      return res.status(400).json({ error: `status must be one of ${[...ALLOWED].join(', ')}` });
    }
    if (instance.status !== 'running' && instance.status !== 'awaiting_approval') {
      return res.status(409).json({
        error: `instance is ${instance.status}, not stuck`,
        instance
      });
    }
    const updated = await updateInstance(
      { work_item_id: instance.work_item_id, workflow_name: instance.workflow_name },
      { status: requested }
    );
    res.json({ ok: true, instance: updated });
  });

  // ============================================================================
  // SIGNAL INBOX — signals / threads / subjects / bootstrap
  // ============================================================================

  router.get('/signals', authenticateProject, async (req, res) => {
    try {
      const { project, priority, needs_me_only, since_min } = req.query;
      const signals = await buildSignalsFeed({
        project_id: project || req.project.id,
        priority: priority || null,
        needs_me_only: needs_me_only === '1' || needs_me_only === 'true',
        since_min: since_min ? parseInt(since_min, 10) : 1440
      });
      res.json({ signals });
    } catch (e) {
      console.error('[signals]', e);
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/threads/:subject_type/:subject_id', authenticateProject, (req, res) => {
    try {
      const { subject_type, subject_id } = req.params;
      const thread = getOrCreateThread(subject_type, subject_id);
      const messages = listThreadMessages(thread.thread_id);
      res.json({ ...thread, messages });
    } catch (e) {
      const status = /not found/i.test(e.message) ? 404 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // Accepts either project key OR admin key. The admin path is used by the
  // devpanel MCP running on the agents host to forward inbound Telegram
  // messages into the shared dashboard DB (single source of truth on services).
  function authenticateProjectOrAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-key'];
    const configuredKey = process.env.ADMIN_API_KEY;
    if (adminKey && configuredKey) {
      const a = Buffer.from(adminKey);
      const b = Buffer.from(configuredKey);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        req.isAdmin = true;
        return next();
      }
    }
    return authenticateProject(req, res, next);
  }

  router.post('/threads/:subject_type/:subject_id/messages', authenticateProjectOrAdmin, async (req, res) => {
    try {
      const { subject_type, subject_id } = req.params;
      const { content, role: reqRole, metadata, source: reqSource, telegram_message_id } = req.body || {};
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'content required' });
      }
      const ALLOWED_ROLES = new Set(['user', 'shelly', 'system', 'agent']);
      const role = reqRole || 'user';
      if (!ALLOWED_ROLES.has(role)) {
        return res.status(400).json({ error: `invalid role: ${role}` });
      }
      // Only admin callers may override source / pass telegram_message_id.
      // Project-key callers always get source='web'.
      const ALLOWED_SOURCES = new Set(['web', 'telegram', 'system']);
      const source = req.isAdmin && reqSource && ALLOWED_SOURCES.has(reqSource) ? reqSource : 'web';
      const tgId = req.isAdmin && Number.isFinite(telegram_message_id) ? telegram_message_id : null;

      // Widget security pipeline — applies only to capture threads coming
      // from a project key (the widget surface). Admin-origin messages
      // (Telegram/MCP inbound) and non-capture subjects are exempt.
      let safeContent = content;
      if (subject_type === 'capture' && !req.isAdmin && req.project) {
        const sec = applyWidgetSecurity({
          project_id: req.project.id,
          type: AUDIT_TYPES.MESSAGE_IN,
          content,
          req
        });
        if (!sec.ok) {
          if (sec.response.retryAfter) res.set('Retry-After', String(sec.response.retryAfter));
          return res.status(sec.response.status).json(sec.response.body);
        }
        safeContent = sec.content;
      }

      const thread = getOrCreateThread(subject_type, subject_id);
      const id = appendThreadMessage({
        thread_id: thread.thread_id, role, source, content: safeContent,
        metadata: metadata ?? null, telegram_message_id: tgId
      });
      // Capture-specific: a shelly reply on a 'new' capture bumps it to 'triaging'
      // so the dashboard badge reflects active conversation (mirrors the old
      // addCaptureMessage behaviour we removed).
      if (subject_type === 'capture' && role === 'shelly') {
        const { updateCapture, getCapture } = await import('./captures.js');
        const cap = getCapture(subject_id);
        if (cap && cap.status === 'new') {
          updateCapture(subject_id, { status: 'triaging' });
        }
      }
      const { broadcast } = await import('./sse.js');
      broadcast('thread:message', {
        thread_id: thread.thread_id,
        subject_type,
        subject_id,
        message: { id, role, source, content: safeContent, metadata: metadata ?? null, created_at: new Date().toISOString() }
      });
      // Forward to Telegram with tag prefix — ONLY for web-source messages.
      // Admin-origin messages are already from Telegram (MCP inbound); re-forwarding
      // would create a loop. Delivery is tracked in telegram_outbound so failures
      // stop being silent.
      if (source === 'web') {
        const text = prependTag(subject_type, subject_id, safeContent);
        forwardToTelegram({
          text, thread_message_id: id, subject_type, subject_id
        }).catch(err => console.error('[threads] telegram forward failed:', err.message));
      }

      // Capture autoroute + Telegram broadcast trigger — the widget posts
      // user content to POST /captures (where neither URL nor screenshot are
      // available yet), then immediately posts a `system` message here
      // carrying metadata.url + metadata.screenshot. That's the moment we can
      // (a) classify by URL pattern and DM the resolved member with the
      // screenshot via their paired bot, and (b) push the [capture-new] line
      // with the screenshot into the legacy observability chat so Franck
      // sees the bug visually instead of just a metadata header.
      // routeCapture is idempotent so a duplicate trigger is safe.
      if (subject_type === 'capture' && role === 'system' && req.project) {
        const { getCapture } = await import('./captures.js');
        const cap = getCapture(subject_id);
        if (cap && !cap.routed_member_id) {
          const { autorouteCapture } = await import('./autoroute-capture.js');
          autorouteCapture({ project: req.project, capture: cap })
            .catch(err => console.error('[autoroute] capture', subject_id, 'failed:', err.message));
        }
        if (cap) {
          const screenshot = (metadata && typeof metadata === 'object' && typeof metadata.screenshot === 'string'
            && metadata.screenshot.startsWith('data:image/'))
              ? metadata.screenshot
              : null;
          notifyCaptureNew({
            project: req.project.name,
            capture_id: cap.id,
            category: cap.routed_label || '',
            content: cap.content,
            screenshot
          }).catch(() => {}); // fire-and-forget, never fail the request
        }
      }
      res.json({ id, thread_id: thread.thread_id });
    } catch (e) {
      const status = /not found/i.test(e.message) ? 404 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  router.patch('/subjects/:subject_type/:subject_id', authenticateProject, (req, res) => {
    try {
      const { subject_type, subject_id } = req.params;
      const { priority, title } = req.body || {};
      if (!getSubject(subject_type, subject_id)) {
        upsertSubject({ subject_type, subject_id, project_id: req.project.id, title: title || null });
      }
      if (priority !== undefined) setPriority(subject_type, subject_id, priority);
      import('./sse.js').then(({ broadcast }) => {
        broadcast('subject:priority_changed', { subject_type, subject_id, priority, project_id: req.project.id });
      }).catch(() => {});
      res.json(getSubject(subject_type, subject_id));
    } catch (e) {
      const status = /invalid/i.test(e.message) ? 400 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  router.post('/projects/from-github', authenticateAdmin, async (req, res) => {
    try {
      const { github_url } = req.body || {};
      if (!github_url) return res.status(400).json({ error: 'github_url required' });
      const result = await bootstrapFromGithub({ github_url });
      res.status(201).json(result);
    } catch (e) {
      const status = /invalid github/i.test(e.message) ? 400
                   : /not found/i.test(e.message)     ? 404
                   : 500;
      res.status(status).json({ error: e.message });
    }
  });

  return router;
}
