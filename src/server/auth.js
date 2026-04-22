// Dashboard auth — Telegram-via-Shelly OTP + Lucia session cookies.
// Single human user (Franck). Sessions persisted in master DB via Lucia's
// SQLite adapter. Challenges (6-digit OTPs) live in memory — they're
// short-lived (5min) and a server restart just forces re-login.
import { Lucia, TimeSpan } from 'lucia';
import { BetterSqlite3Adapter } from '@lucia-auth/adapter-sqlite';
import { randomInt } from 'crypto';

// Inline Telegram helpers — keep auth self-contained (alerts.js _sendText is private).
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
const challenges = new Map(); // code -> { client_hint, ip, created_at, ready }

let lucia = null;

export function initAuth(masterDb) {
  // Lucia requires `user` and `session` tables. We only have one user.
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
  // Insert the single user row if missing.
  masterDb.prepare('INSERT OR IGNORE INTO user (id) VALUES (?)').run(SINGLE_USER_ID);

  const adapter = new BetterSqlite3Adapter(masterDb, { user: 'user', session: 'session' });
  lucia = new Lucia(adapter, {
    sessionCookie: {
      name: 'devpanl_session',
      expires: false, // we'll let Lucia compute Max-Age from session expiry
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
  for (const [code, ch] of challenges) if (ch.created_at < cutoff) challenges.delete(code);
}

export async function startChallenge({ client_hint, ip }) {
  gc();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  challenges.set(code, { client_hint, ip, created_at: Date.now(), ready: false });
  let notification_sent = false;
  if (_hasDest()) {
    const where = client_hint || 'unknown browser';
    const when = new Date().toISOString().slice(11, 19);
    const ipPart = ip ? ` (IP ${ip})` : '';
    try {
      await _send(
        `[auth] Login dashboard depuis ${where}${ipPart} à ${when} UTC. ` +
        `Code attendu: ${code}. Expire dans 5 min.`
      );
      notification_sent = true;
    } catch (err) {
      console.error('[Auth] notify failed:', err.message);
    }
  }
  return { code, ttl: 300, notification_sent };
}

export function verifyChallenge({ code, telegram_user_id }) {
  const authorized = parseInt(process.env.AUTHORIZED_TELEGRAM_USER_ID || '0', 10);
  if (!authorized || parseInt(telegram_user_id, 10) !== authorized) {
    return { ok: false, reason: 'unauthorized_user' };
  }
  gc();
  const ch = challenges.get(code);
  if (!ch) return { ok: false, reason: 'unknown_code' };
  ch.ready = true;
  return { ok: true };
}

export function denyChallenge({ code }) {
  if (!challenges.delete(code)) return { ok: false, reason: 'unknown_code' };
  return { ok: true };
}

// Called by /auth/check polling. Returns 'ready' once, then deletes the
// challenge. Caller should also create a Lucia session at that point.
export function consumeChallenge(code) {
  const ch = challenges.get(code);
  if (!ch) return 'unknown';
  if (!ch.ready) return 'pending';
  challenges.delete(code);
  return 'ready';
}

export function singleUserId() { return SINGLE_USER_ID; }
