import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  getProjectByApiKey,
  createProject,
  listProjects,
  getProjectByName,
  initProjectDatabase,
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
  answerClarification
} from './db.js';
import { initGitHub, listIssues, getGitHub, fetchRepoDocs, fetchMilestones } from './github.js';

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

    if (!adminKey || adminKey !== configuredKey) {
      return res.status(401).json({ error: 'Invalid or missing admin key. Provide via X-Admin-Key header.' });
    }

    next();
  }

  // ============================================================================
  // PUBLIC ENDPOINTS (No auth)
  // ============================================================================

  // Health check
  router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ============================================================================
  // PROJECT MANAGEMENT (No project auth - admin endpoints)
  // ============================================================================

  // List all projects
  router.get('/projects', authLimiter, authenticateAdmin, (req, res) => {
    try {
      const projects = listProjects();
      res.json({ projects });
    } catch (error) {
      res.status(500).json({ error: error.message });
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

  return router;
}
