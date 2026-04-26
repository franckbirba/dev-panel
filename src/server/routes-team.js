// src/server/routes-team.js
// Per-project team & routing routes. Registered into the main createRouter()
// from routes.js so they share authenticateProject and the /api prefix.
//
// Why a separate file: keeps team-routing code out of the already-large
// routes.js (~1500 lines). The file exports defineTeamRoutes(router, auth)
// rather than mounting on app, because authenticateProject is module-private
// to routes.js — sharing the middleware is simpler than re-exporting it.

import {
  addMember, listMembers, updateMember, deleteMember,
  setRoutingForProject, listRoutingForProject, listLabelsForProject,
  listUrlPatterns, setUrlPatternsForProject
} from './team.js';

export function defineTeamRoutes(router, authenticateProject) {
  router.get('/team', authenticateProject, async (req, res) => {
    try {
      const [members, routing] = await Promise.all([
        listMembers(req.project.id),
        listRoutingForProject(req.project.id)
      ]);
      res.json({ members, routing });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/team/labels', authenticateProject, async (req, res) => {
    try {
      const labels = await listLabelsForProject(req.project.id);
      res.json(labels);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/team/routing', authenticateProject, async (req, res) => {
    try {
      const routing = await listRoutingForProject(req.project.id);
      res.json(routing);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/team/routing', authenticateProject, async (req, res) => {
    const rules = Array.isArray(req.body) ? req.body : [];
    if (rules.some(r => !r || typeof r.label !== 'string' || typeof r.member_id !== 'number')) {
      return res.status(400).json({ error: 'expected [{label, member_id}, ...]' });
    }
    try {
      await setRoutingForProject(req.project.id, rules);
      const out = await listRoutingForProject(req.project.id);
      res.json(out);
    } catch (err) {
      if (/not belong to this project|expected/i.test(err.message)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/team/members', authenticateProject, async (req, res) => {
    const { display_name, dev_bot_id } = req.body ?? {};
    if (!display_name || !dev_bot_id) {
      return res.status(400).json({ error: 'display_name and dev_bot_id required' });
    }
    try {
      const m = await addMember({ project_id: req.project.id, display_name, dev_bot_id });
      const list = await listMembers(req.project.id);
      const full = list.find(x => x.id === m.id);
      res.status(201).json(full);
    } catch (err) {
      if (/duplicate|unique/i.test(err.message)) {
        return res.status(409).json({ error: err.message });
      }
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/team/members/:id', authenticateProject, async (req, res) => {
    const { display_name, dev_bot_id } = req.body ?? {};
    try {
      const m = await updateMember(parseInt(req.params.id, 10), { display_name, dev_bot_id });
      res.json(m);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/team/members/:id', authenticateProject, async (req, res) => {
    try {
      await deleteMember(parseInt(req.params.id, 10));
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/team/url-patterns', authenticateProject, async (req, res) => {
    try {
      const rows = await listUrlPatterns(req.project.id);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/team/url-patterns', authenticateProject, async (req, res) => {
    const patterns = Array.isArray(req.body) ? req.body : [];
    if (patterns.some(p => !p || typeof p.pattern !== 'string' || typeof p.label !== 'string')) {
      return res.status(400).json({ error: 'expected [{pattern, label, priority?}, ...]' });
    }
    try {
      await setUrlPatternsForProject(req.project.id, patterns);
      const out = await listUrlPatterns(req.project.id);
      res.json(out);
    } catch (err) {
      if (/expected|duplicate|unique/i.test(err.message)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: err.message });
    }
  });
}
