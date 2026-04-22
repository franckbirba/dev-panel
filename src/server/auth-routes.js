// /auth/* HTTP endpoints. Admin-key gates verify/deny (Shelly's MCP calls
// these with X-Admin-Key). Browser polls /auth/check; on 'ready' we create
// a Lucia session and set the cookie. /auth/logout invalidates the session.
import express from 'express';
import { timingSafeEqual } from 'crypto';
import {
  startChallenge, verifyChallenge, denyChallenge,
  consumeChallenge, getLucia, singleUserId
} from './auth.js';

function checkAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];
  const configured = process.env.ADMIN_API_KEY;
  if (!key || !configured) return res.status(401).json({ error: 'admin key required' });
  const a = Buffer.from(key);
  const b = Buffer.from(configured);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'admin key invalid' });
  }
  next();
}

export function createAuthRouter() {
  const router = express.Router();

  router.post('/start', async (req, res) => {
    const client_hint = req.body?.client_hint || null;
    const ip = req.ip || req.socket?.remoteAddress || null;
    const challenge = await startChallenge({ client_hint, ip });
    res.json(challenge);
  });

  router.post('/verify', checkAdminKey, (req, res) => {
    const { code, telegram_user_id } = req.body || {};
    if (!code || typeof code !== 'string') return res.json({ ok: false, reason: 'unknown_code' });
    res.json(verifyChallenge({ code, telegram_user_id }));
  });

  router.post('/deny', checkAdminKey, (req, res) => {
    const { code } = req.body || {};
    if (!code || typeof code !== 'string') return res.json({ ok: false, reason: 'unknown_code' });
    res.json(denyChallenge({ code }));
  });

  router.get('/check', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: 'code required' });
    const state = consumeChallenge(code);
    if (state === 'unknown') return res.json({ state: 'unknown' });
    if (state === 'pending') return res.json({ state: 'pending' });
    // ready — mint a Lucia session and set the cookie
    const lucia = getLucia();
    const session = await lucia.createSession(singleUserId(), {});
    const sessionCookie = lucia.createSessionCookie(session.id);
    res.appendHeader('Set-Cookie', sessionCookie.serialize());
    res.json({ state: 'ready', ok: true });
  });

  router.post('/logout', async (req, res) => {
    const sid = req.cookies?.devpanl_session;
    if (sid) {
      try { await getLucia().invalidateSession(sid); } catch { /* idempotent */ }
    }
    const blank = getLucia().createBlankSessionCookie();
    res.appendHeader('Set-Cookie', blank.serialize());
    res.json({ ok: true });
  });

  router.get('/me', async (req, res) => {
    const sid = req.cookies?.devpanl_session;
    if (!sid) return res.json({ authenticated: false });
    const lucia = getLucia();
    const { session } = await lucia.validateSession(sid);
    if (!session) return res.json({ authenticated: false });
    res.json({ authenticated: true, expires_at: session.expiresAt });
  });

  return router;
}
