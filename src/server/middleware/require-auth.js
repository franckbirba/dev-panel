// Project API key OR admin key. The SPA's per-route auth uses the project
// key from localStorage (X-API-Key), the CLI uses X-Admin-Key. The Google
// SSO gate in front of the SPA is enforced by Traefik, not Express — see
// require-forwarded-user.js for the SPA-bootstrap gate.
import { timingSafeEqual } from 'crypto';
import { getProjectByApiKey } from '../db.js';

export async function requireAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey) {
    const project = getProjectByApiKey(apiKey);
    if (project) {
      req.project = project;
      req.user = { type: 'project_key', project_id: project.id };
      return next();
    }
  }
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
  return res.status(401).json({ error: 'Authentication required' });
}
