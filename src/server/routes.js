import express from 'express';
import rateLimit from 'express-rate-limit';
import { timingSafeEqual } from 'crypto';
import { requireAuth } from './middleware/require-auth.js';
import {
  getProjectByApiKey,
  createProject,
  listProjects,
  getProjectByName,
  getProjectById,
  getMasterDatabase,
  updateProject,
  deleteProject,
  initProjectDatabase,
} from './db.js';
import {
  createCapture, getCapture, listCaptures,
  updateCapture, deleteCapture
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
  addMessage
} from './db.js';
import { initGitHub, listIssues, getGitHub, fetchRepoDocs, fetchMilestones, fetchIssueComments } from './github.js';
import { addClient, broadcast } from './sse.js';
import { publishTicket, rejectTicket } from './services.js';
import { getQueue, QUEUES, PRIORITY_MAP } from './bullmq.js';

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
    const adminKey = req.headers['x-admin-key'];
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
      return res.status(401).json({ error: 'Invalid or missing admin key. Provide via X-Admin-Key header.' });
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

  // Health check — detailed (admin only)
  router.get('/health/detailed', authenticateAdmin, async (req, res) => {
    const { getHealthStatus } = await import('./monitoring.js');
    const health = await getHealthStatus(storagePath);

    res.status(health.status === 'down' ? 503 : 200).json(health);
  });

  // Queue health
  router.get('/health/queues', authenticateAdmin, async (req, res) => {
    try {
      const { getAllQueuesHealth } = await import('./bullmq.js');
      const health = await getAllQueuesHealth();

      res.status(health.status === 'critical' ? 503 : 200).json(health);
    } catch (error) {
      res.status(500).json({ error: error.message, status: 'unknown' });
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

  // List all projects — requireAuth so a logged-in human (cookie session)
  // gets the full list with api_keys, allowing the dashboard to hydrate the
  // localStorage project switcher on a fresh browser. Admin key still works
  // for scripts; project keys are NOT enough (a project key shouldn't expose
  // sibling projects' keys).
  router.get('/projects', authLimiter, requireAuth, (req, res) => {
    if (req.user?.type === 'project_key') {
      return res.status(403).json({ error: 'project key cannot list all projects' });
    }
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

  router.post('/captures', authenticateProject, (req, res) => {
    try {
      const { content = '', kind = 'idea' } = req.body || {};
      if (!String(content).trim()) return res.status(400).json({ error: 'content required' });
      const capture = createCapture({
        project_id: req.project.id,
        content: String(content).slice(0, 4000),
        kind: String(kind).slice(0, 32)
      });
      res.status(201).json(capture);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/captures', authenticateProject, (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : null;
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
      res.json({ captures: listCaptures({ project_id: req.project.id, status, limit }) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/captures/:id', authenticateProject, (req, res) => {
    try {
      const c = getCapture(req.params.id);
      if (!c || c.project_id !== req.project.id) return res.status(404).json({ error: 'not found' });
      res.json(c);
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

  // ============================================================================
  // TODAY VIEW — single actionable feed across the whole team.
  // Aggregates from three sources: workflow_instances (engine state),
  // BullMQ agents queue (job-level failures), and per-project tickets.
  // Project key auth (read-only metrics, nothing destructive).
  // ============================================================================

  router.get('/today', authenticateProject, async (req, res) => {
    try {
      const masterDb = getMasterDatabase();
      const now = Date.now();
      const dayAgo = now - 24 * 3600 * 1000;
      const ageMin = (ts) => Math.max(0, Math.round((now - ts) / 60000));

      // Workflow instances — full picture from the engine.
      const allInstances = masterDb.prepare(
        `SELECT * FROM workflow_instances ORDER BY last_event_at DESC LIMIT 200`
      ).all();

      const parseMeta = (m) => { try { return m ? JSON.parse(m) : null; } catch { return null; } };

      const needs_attention = [];
      const in_progress = [];
      const shipped_today = [];

      for (const inst of allInstances) {
        const meta = parseMeta(inst.metadata);
        const base = {
          instance_id: inst.id,
          work_item_id: inst.work_item_id,
          workflow: inst.workflow_name,
          step: inst.current_step,
          revision: inst.revision,
          status: inst.status,
          age_min: ageMin(inst.last_event_at),
          last_event_at: inst.last_event_at,
          metadata: meta
        };
        if (inst.status === 'exhausted' || inst.status === 'awaiting_approval') {
          needs_attention.push({ kind: `workflow_${inst.status}`, ...base });
        } else if (inst.status === 'running') {
          in_progress.push({ kind: 'workflow_running', ...base });
        } else if (inst.status === 'done' && inst.last_event_at >= dayAgo) {
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
      const { type, title, description, context, screenshot, created_by } = req.body;

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

  router.get('/admin/workflows/instances', authenticateAdmin, async (req, res) => {
    const { listActive, listByCycle } = await import('./workflow-instances.js');
    const rows = req.query.cycle_id ? listByCycle(req.query.cycle_id) : listActive();
    res.json({ instances: rows });
  });

  router.get('/admin/workflows/instances/:id', authenticateAdmin, async (req, res) => {
    const { loadInstanceById } = await import('./workflow-instances.js');
    const { listSteps } = await import('./jobs-log.js');
    const instance = loadInstanceById(parseInt(req.params.id, 10));
    if (!instance) return res.status(404).json({ error: 'not found' });
    const steps = instance.last_job_id ? listSteps(instance.last_job_id) : [];
    res.json({ instance, steps });
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

  router.post('/threads/:subject_type/:subject_id/messages', authenticateProject, async (req, res) => {
    try {
      const { subject_type, subject_id } = req.params;
      const { content, role: reqRole, metadata } = req.body || {};
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'content required' });
      }
      const ALLOWED_ROLES = new Set(['user', 'shelly', 'system', 'agent']);
      const role = reqRole || 'user';
      if (!ALLOWED_ROLES.has(role)) {
        return res.status(400).json({ error: `invalid role: ${role}` });
      }
      const thread = getOrCreateThread(subject_type, subject_id);
      const id = appendThreadMessage({ thread_id: thread.thread_id, role, source: 'web', content, metadata: metadata ?? null });
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
        message: { id, role, source: 'web', content, metadata: metadata ?? null, created_at: new Date().toISOString() }
      });
      // Forward to Telegram with tag prefix; fire-and-forget.
      const text = prependTag(subject_type, subject_id, content);
      const url = process.env.SHELLY_TELEGRAM_WEBHOOK;
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chat  = process.env.TELEGRAM_CHAT_ID;
      if (url) {
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
          .catch(err => console.error('[threads] webhook send failed:', err.message));
      } else if (token && chat) {
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text })
        }).catch(err => console.error('[threads] telegram API send failed:', err.message));
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
