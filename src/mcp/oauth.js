// OAuth 2.1 (Google) for the /mcp endpoint.
//
// Threat model: we are both the issuer and the verifier of access tokens
// (single backend, no third-party token consumers). HMAC-SHA256 with a
// server-side secret (OAUTH_TOKEN_SECRET) gives the integrity + expiry
// guarantees we need without a JWT library dep. Tokens are JSON payloads
// base64url-encoded and signed; verification is constant-time.
//
// History: the first version on main (95dbc46) base64-encoded an unsigned
// JSON payload and called it a "demo" — that lets any caller forge a
// token by base64-encoding {"sub":"x","exp":<future>}. Confirmed live
// against prod /mcp before this fix landed. Do NOT regress to unsigned.

import { generateState, generateCodeVerifier } from 'arctic';
import { createHmac, createHash, timingSafeEqual } from 'crypto';

// Read env at call time, not at module load — env vars set late (by
// init.sh, by a test harness, by docker secrets mounted after import)
// must reach this code. Also lets tests delete a var to assert the
// fail-closed behavior.
function googleConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.OAUTH_REDIRECT_URI || 'https://devpanl.dev/mcp/oauth/callback',
    scopes: ['openid', 'profile', 'email']
  };
}

// HMAC secret. Must be set in any environment that mounts the OAuth path.
// mountMcpHttp() refuses to enable the OAuth verification path if absent,
// so the only way a request gets here is if the secret exists.
function getTokenSecret() {
  const s = process.env.OAUTH_TOKEN_SECRET;
  if (!s || s.length < 32) {
    throw new Error('OAUTH_TOKEN_SECRET missing or too short (need ≥32 chars)');
  }
  return s;
}

export function oauthTokenSecretConfigured() {
  const s = process.env.OAUTH_TOKEN_SECRET;
  return typeof s === 'string' && s.length >= 32;
}

const oauthSessions = new Map();

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payloadB64) {
  return b64urlEncode(createHmac('sha256', getTokenSecret()).update(payloadB64).digest());
}

// PKCE-enabled authorization URL. Returns { url, sessionId }; the sessionId
// is what the caller stores in a short-lived cookie so the callback can
// retrieve state + codeVerifier when Google redirects back.
export function generateAuthUrl() {
  const cfg = googleConfig();
  if (!cfg.clientId) {
    throw new Error('GOOGLE_CLIENT_ID not configured');
  }

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  // PKCE S256: code_challenge = BASE64URL(SHA256(code_verifier)) — RFC 7636 §4.2.
  const codeChallenge = b64urlEncode(createHash('sha256').update(codeVerifier).digest());
  const sessionId = generateState();

  oauthSessions.set(sessionId, { state, codeVerifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: cfg.scopes.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });

  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    sessionId
  };
}

export async function exchangeCodeForTokens(code, state, storedState, codeVerifier) {
  if (state !== storedState) {
    throw new Error('Invalid state parameter');
  }
  const cfg = googleConfig();

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to exchange code for tokens: ${response.status} ${errorText}`);
  }

  return await response.json();
}

export async function getUserInfo(idToken) {
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
  if (!response.ok) {
    throw new Error('Failed to verify ID token');
  }

  const userInfo = await response.json();

  const cfg = googleConfig();
  if (userInfo.aud !== cfg.clientId) {
    throw new Error('Invalid token audience');
  }

  return {
    id: userInfo.sub,
    email: userInfo.email,
    name: userInfo.name,
    picture: userInfo.picture,
    email_verified: userInfo.email_verified === 'true'
  };
}

// Issue a signed access token. Format: <b64url(payload)>.<b64url(hmac)>.
// HMAC covers the payload bytes exactly as transmitted, so any mutation
// (including the dot separator) breaks verification.
export function createAccessToken(userInfo, sessionId) {
  const payload = {
    sub: userInfo.id,
    email: userInfo.email,
    name: userInfo.name,
    sessionId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24)
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

export function verifyAccessToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new Error('Invalid token');
  }
  const [payloadB64, sigB64] = token.split('.', 2);
  if (!payloadB64 || !sigB64) {
    throw new Error('Invalid token');
  }
  const expected = sign(payloadB64);
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Invalid token');
  }
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf-8'));
  } catch {
    throw new Error('Invalid token');
  }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }
  return payload;
}

export function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of oauthSessions.entries()) {
    if (now - session.createdAt > 60 * 60 * 1000) {
      oauthSessions.delete(sessionId);
    }
  }
}

// Opt-in: start the periodic session GC. Was a module-load setInterval
// before, which kept the test runner alive and ran in every importer.
// mountMcpHttp() calls this once at boot.
let cleanupTimer = null;
export function startCleanupTimer() {
  if (cleanupTimer) return cleanupTimer;
  cleanupTimer = setInterval(cleanupExpiredSessions, 10 * 60 * 1000);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
  return cleanupTimer;
}

export function stopCleanupTimer() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

export { oauthSessions };
