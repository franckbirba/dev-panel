// Trust Traefik's X-Forwarded-User header (set by traefik-forward-auth after
// Google SSO). Off by default so a curl directly against the container — or
// local dev without Traefik — does not auto-authenticate. Enable explicitly
// in the production docker-compose env: TRUST_FORWARDED_USER=true.
//
// CRITICAL: this only safe when the upstream proxy (Traefik) strips any
// inbound X-Forwarded-User from the client before adding its own. With
// thomseddon/traefik-forward-auth + Traefik's default ForwardAuth, that's
// the case. Document the deployment assumption in infra/INDEX.md.
export function requireForwardedUser(req, res, next) {
  if (process.env.TRUST_FORWARDED_USER !== 'true') {
    return res.status(401).json({ error: 'forwarded user trust disabled' });
  }
  const raw = req.headers['x-forwarded-user'];
  const email = typeof raw === 'string' ? raw.trim() : '';
  if (!email) {
    return res.status(401).json({ error: 'forwarded user header missing' });
  }
  req.user = { type: 'forwarded_user', email };
  next();
}
