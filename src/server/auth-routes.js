// /auth/* HTTP endpoints.
// Browser flow: POST /auth/start → POST /auth/redeem (with the code Franck
// typed). Set-Cookie devpanl_session is issued on successful redeem.
// /auth/deny is admin-key gated (Shelly's MCP) — lets the user reject a
// suspicious login attempt from Telegram.
import express from 'express';
import { timingSafeEqual } from 'crypto';
import {
  startChallenge, redeemChallenge, denyChallenge, challengeStatus,
  getLucia, singleUserId
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
    res.json(await startChallenge({ client_hint, ip }));
  });

  router.post('/redeem', async (req, res) => {
    const { challenge_id, code } = req.body || {};
    if (!challenge_id || !code) {
      return res.status(400).json({ ok: false, reason: 'missing_fields' });
    }
    const result = redeemChallenge({ challenge_id, code });
    if (!result.ok) return res.json(result);
    // Mint Lucia session and set cookie.
    const lucia = getLucia();
    const session = await lucia.createSession(singleUserId(), {});
    const cookie = lucia.createSessionCookie(session.id);
    res.appendHeader('Set-Cookie', cookie.serialize());
    res.json({ ok: true });
  });

  router.get('/status', (req, res) => {
    const id = req.query.challenge_id;
    if (!id) return res.status(400).json({ error: 'challenge_id required' });
    res.json({ state: challengeStatus(id) });
  });

  router.post('/deny', checkAdminKey, (req, res) => {
    const { challenge_id } = req.body || {};
    if (!challenge_id) return res.json({ ok: false, reason: 'missing_challenge_id' });
    res.json(denyChallenge({ challenge_id }));
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
