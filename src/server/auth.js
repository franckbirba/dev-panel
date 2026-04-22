// Dashboard auth — Telegram-relayed OTP + Lucia session cookies.
// Flow:
//   1. Browser POST /auth/start → server generates {challenge_id, code, ttl},
//      pushes code to Franck via Shelly Telegram, returns ONLY {challenge_id, ttl}
//      (the browser must never see the code — that's the whole point).
//   2. Franck reads code in Telegram, types it into the dashboard input.
//   3. Browser POST /auth/redeem {challenge_id, code} → server matches, mints
//      a Lucia session, sets the cookie.
//
// Single human user (Franck). Sessions persisted in master DB via Lucia's
// SQLite adapter. Challenges live in memory — short-lived (5min) and a
// server restart just forces re-login.
import { Lucia, TimeSpan } from 'lucia';
import { BetterSqlite3Adapter } from '@lucia-auth/adapter-sqlite';
import { randomBytes, randomInt, timingSafeEqual } from 'crypto';

// Inline Telegram helpers — keep auth self-contained.
function _hasDest() {
  return Boolean(
    process.env.SHELLY_TELEGRAM_WEBHOOK ||
    (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
  );
}
async function _send(text) {
  const url = process.env.SHELLY_TELEGRAM_WEBHOOK;
  if (url) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (token && chat) {
    return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text })
    });
  }
}

const SINGLE_USER_ID = 'franck';
const TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
// challenge_id -> { code, client_hint, ip, created_at, attempts, denied }
const challenges = new Map();

let lucia = null;

export function initAuth(masterDb) {
  masterDb.exec(`
    CREATE TABLE IF NOT EXISTS user (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      user_id TEXT NOT NULL REFERENCES user(id)
    );
  `);
  masterDb.prepare('INSERT OR IGNORE INTO user (id) VALUES (?)').run(SINGLE_USER_ID);

  const adapter = new BetterSqlite3Adapter(masterDb, { user: 'user', session: 'session' });
  lucia = new Lucia(adapter, {
    sessionCookie: {
      name: 'devpanl_session',
      expires: false,
      attributes: {
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/'
      }
    },
    sessionExpiresIn: new TimeSpan(30, 'd')
  });
  return lucia;
}

export function getLucia() {
  if (!lucia) throw new Error('Auth not initialized — call initAuth(masterDb) first');
  return lucia;
}

function gc() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, ch] of challenges) if (ch.created_at < cutoff) challenges.delete(id);
}

export async function startChallenge({ client_hint, ip }) {
  gc();
  const challenge_id = 'ch_' + randomBytes(8).toString('hex');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  challenges.set(challenge_id, {
    code, client_hint, ip,
    created_at: Date.now(),
    attempts: 0,
    denied: false
  });
  let notification_sent = false;
  if (_hasDest()) {
    const where = client_hint || 'unknown browser';
    const when = new Date().toISOString().slice(11, 19);
    const ipPart = ip ? ` (IP ${ip})` : '';
    try {
      await _send(
        `[auth] Login dashboard depuis ${where}${ipPart} à ${when} UTC.\n` +
        `Code à taper dans le dashboard: ${code}\n` +
        `Expire dans 5 min. Réponds "non" si c'est pas toi.\n` +
        `<!-- challenge_id:${challenge_id} -->`
      );
      notification_sent = true;
    } catch (err) {
      console.error('[Auth] notify failed:', err.message);
    }
  }
  // Browser only gets challenge_id + ttl + notification_sent. NEVER the code.
  return { challenge_id, ttl: 300, notification_sent };
}

// Called by the browser when Franck submits the code from the input field.
export function redeemChallenge({ challenge_id, code }) {
  gc();
  const ch = challenges.get(challenge_id);
  if (!ch) return { ok: false, reason: 'expired' };
  if (ch.denied) {
    challenges.delete(challenge_id);
    return { ok: false, reason: 'denied' };
  }
  ch.attempts += 1;
  if (ch.attempts > MAX_ATTEMPTS) {
    challenges.delete(challenge_id);
    return { ok: false, reason: 'too_many_attempts' };
  }
  if (typeof code !== 'string' || code.length !== ch.code.length) {
    return { ok: false, reason: 'invalid_code' };
  }
  // Constant-time compare to neutralize timing-based code guessing.
  const a = Buffer.from(ch.code);
  const b = Buffer.from(code);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'invalid_code', attempts_left: MAX_ATTEMPTS - ch.attempts };
  }
  challenges.delete(challenge_id);
  return { ok: true };
}

// Optional: Shelly (or anyone with admin key) can mark a challenge as denied
// — useful when Franck sees the [auth] message and replies "non, c'est pas moi".
// The browser polling /auth/status will see denied and stop trying.
export function denyChallenge({ challenge_id }) {
  const ch = challenges.get(challenge_id);
  if (!ch) return { ok: false, reason: 'unknown' };
  ch.denied = true;
  return { ok: true };
}

// Optional: browser polls this to detect a deny (Shelly-side rejection)
// without having to keep submitting wrong codes.
export function challengeStatus(challenge_id) {
  const ch = challenges.get(challenge_id);
  if (!ch) return 'expired';
  if (ch.denied) return 'denied';
  return 'pending';
}

export function singleUserId() { return SINGLE_USER_ID; }
