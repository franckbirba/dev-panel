// src/worker/readiness-route.js
//
// GET /readiness/:project_id?local_path=<path> — the worker-local half of
// ADR-003 §2's readiness contract. Runs A1-A3 (src/worker/readiness-local.js)
// against the filesystem the worker actually has. project_id is accepted
// for logging/symmetry with the services-side route but is NOT used to
// resolve local_path here — the worker's own storage/projects.db is empty
// on the agents host (DEVPA-180), so the caller (src/server/readiness.js)
// passes local_path explicitly from the authoritative services table.
//
// Split into its own module (rather than inlined in src/worker/api.js) so
// it can be unit-tested without importing src/worker/index.js, which opens
// a real Redis/BullMQ connection on import — see tests/worker/readiness-route.test.js.

import { checkLocalReadiness } from './readiness-local.js';

export function registerReadinessRoute(app) {
  app.get('/readiness/:project_id', async (req, res) => {
    const localPath = req.query.local_path ? String(req.query.local_path) : '';
    if (!localPath) {
      return res.status(400).json({ error: 'local_path query param required' });
    }
    try {
      const checks = await checkLocalReadiness(localPath);
      res.json({ project_id: req.params.project_id, checks });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
