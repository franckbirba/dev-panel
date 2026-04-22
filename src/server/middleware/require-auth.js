// Auth chain: Lucia session cookie → project API key → admin key → 401.
// Used on dashboard-facing routes. M2M widgets and CLI scripts keep working
// because their X-API-Key / X-Admin-Key are still accepted as fallbacks.
import { timingSafeEqual } from 'crypto';
import { getLucia } from '../auth.js';
import { getProjectByApiKey } from '../db.js';

export async function requireAuth(req, res, next) {
  // 1. Lucia session cookie
  const sid = req.cookies?.devpanl_session;
  if (sid) {
    try {
      const { session } = await getLucia().validateSession(sid);
      if (session) {
        // Lucia handles sliding expiration internally.
        if (session.fresh) {
          const cookie = getLucia().createSessionCookie(session.id);
          res.appendHeader('Set-Cookie', cookie.serialize());
        }
        req.user = { type: 'session', session_id: sid };
        return next();
      }
    } catch (err) {
      // Auth not initialized or storage error — fall through to other auth.
    }
  }
  // 2. Project API key
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey) {
    const project = getProjectByApiKey(apiKey);
    if (project) {
      req.project = project;
      req.user = { type: 'project_key', project_id: project.id };
      return next();
    }
  }
  // 3. Admin key
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
