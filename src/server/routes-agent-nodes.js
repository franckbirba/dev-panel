import {
  registerAgentNode,
  getAgentNode,
  revokeAgentNode,
  createTaskToken,
  revokeTaskToken
} from './db.js';

export function defineAgentNodeRoutes(router, authenticateAdmin) {
  router.post('/admin/agent-nodes', authenticateAdmin, (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
        return res.status(400).json({ error: 'name must match [a-zA-Z0-9._-]{1,64}' });
      }
      const registration = registerAgentNode({ name });
      res.status(201).json({ node_id: registration.node_id, token: registration.token });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/admin/agent-nodes/:id', authenticateAdmin, (req, res) => {
    const result = revokeAgentNode(req.params.id, req.body?.reason || 'revoked by admin');
    if (!result.changes) return res.status(404).json({ error: 'node not found' });
    res.json({ ok: true });
  });

  router.post('/admin/agent-task-tokens', authenticateAdmin, (req, res) => {
    try {
      const { node_id, task_id, repository, branch } = req.body || {};
      const expiresInSeconds = Number(req.body?.expires_in_seconds || 3600);
      if (!getAgentNode(node_id)) return res.status(404).json({ error: 'node not found' });
      if (!task_id || typeof task_id !== 'string') return res.status(400).json({ error: 'task_id required' });
      if (!/^[^/\s]+\/[^/\s]+$/.test(repository || '')) {
        return res.status(400).json({ error: 'repository must be owner/repo' });
      }
      if (!branch || /\s/.test(branch)) return res.status(400).json({ error: 'invalid branch' });
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 86400) {
        return res.status(400).json({ error: 'expires_in_seconds must be between 60 and 86400' });
      }
      const issued = createTaskToken({
        node_id,
        task_id,
        repository,
        branch,
        expires_at: new Date(Date.now() + expiresInSeconds * 1000)
      });
      res.status(201).json({
        id: issued.id,
        token: issued.token,
        task_id,
        repository,
        branch,
        expires_in_seconds: expiresInSeconds
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/admin/agent-task-tokens/revoke', authenticateAdmin, (req, res) => {
    const result = revokeTaskToken(req.body?.token, req.body?.reason || 'revoked by admin');
    if (!result.changes) return res.status(404).json({ error: 'token not found' });
    res.json({ ok: true });
  });
}
