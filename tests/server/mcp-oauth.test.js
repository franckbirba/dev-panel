import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const TEST_SECRET = 'a'.repeat(64);
process.env.OAUTH_TOKEN_SECRET = TEST_SECRET;
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';

const oauthMod = await import('../../src/mcp/oauth.js');
const {
  createAccessToken,
  verifyAccessToken,
  generateAuthUrl,
  oauthTokenSecretConfigured,
  stopCleanupTimer
} = oauthMod;

afterEach(() => {
  stopCleanupTimer();
});

describe('verifyAccessToken — forgery resistance', () => {
  test('rejects unsigned base64 JSON (the 95dbc46 vulnerability)', () => {
    const forged = Buffer.from(
      JSON.stringify({ sub: 'attacker', email: 'evil@example.com', exp: 9999999999 })
    ).toString('base64');
    assert.throws(() => verifyAccessToken(forged), /Invalid token/);
  });

  test('rejects token with valid payload but tampered signature', () => {
    const good = createAccessToken({ id: 'u1', email: 'a@b', name: 'A' }, 'sess1');
    const [payload, sig] = good.split('.');
    const tamperedChar = sig.slice(-1) === 'A' ? 'B' : 'A';
    const tampered = `${payload}.${sig.slice(0, -1)}${tamperedChar}`;
    assert.throws(() => verifyAccessToken(tampered), /Invalid token/);
  });

  test('rejects token with tampered payload (signature no longer matches)', () => {
    const good = createAccessToken({ id: 'u1', email: 'a@b', name: 'A' }, 'sess1');
    const [, sig] = good.split('.');
    const evilPayload = Buffer.from(
      JSON.stringify({ sub: 'attacker', exp: 9999999999 })
    ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const forged = `${evilPayload}.${sig}`;
    assert.throws(() => verifyAccessToken(forged), /Invalid token/);
  });

  test('rejects token signed with a different secret', () => {
    const good = createAccessToken({ id: 'u1', email: 'a@b', name: 'A' }, 'sess1');
    process.env.OAUTH_TOKEN_SECRET = 'b'.repeat(64);
    try {
      assert.throws(() => verifyAccessToken(good), /Invalid token/);
    } finally {
      process.env.OAUTH_TOKEN_SECRET = TEST_SECRET;
    }
  });

  test('rejects empty string, missing dot, malformed shape', () => {
    assert.throws(() => verifyAccessToken(''), /Invalid token/);
    assert.throws(() => verifyAccessToken('no-dot-here'), /Invalid token/);
    assert.throws(() => verifyAccessToken('a.'), /Invalid token/);
    assert.throws(() => verifyAccessToken('.b'), /Invalid token/);
    assert.throws(() => verifyAccessToken(null), /Invalid token/);
    assert.throws(() => verifyAccessToken(undefined), /Invalid token/);
  });
});

describe('verifyAccessToken — happy path + expiry', () => {
  test('round-trips a token issued by createAccessToken', () => {
    const userInfo = { id: 'user-42', email: 'a@b.com', name: 'Alice' };
    const token = createAccessToken(userInfo, 'sess-xyz');
    const payload = verifyAccessToken(token);
    assert.equal(payload.sub, 'user-42');
    assert.equal(payload.email, 'a@b.com');
    assert.equal(payload.name, 'Alice');
    assert.equal(payload.sessionId, 'sess-xyz');
    assert.equal(typeof payload.iat, 'number');
    assert.equal(typeof payload.exp, 'number');
    assert.ok(payload.exp > payload.iat);
  });

  test('rejects an expired token', () => {
    const realNow = Date.now;
    try {
      Date.now = () => new Date('2020-01-01T00:00:00Z').getTime();
      const expired = createAccessToken({ id: 'u', email: 'a@b', name: 'A' }, 's');
      Date.now = realNow;
      assert.throws(() => verifyAccessToken(expired), /expired/i);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('OAUTH_TOKEN_SECRET enforcement', () => {
  test('oauthTokenSecretConfigured reflects env', () => {
    assert.equal(oauthTokenSecretConfigured(), true);
    const prev = process.env.OAUTH_TOKEN_SECRET;
    try {
      delete process.env.OAUTH_TOKEN_SECRET;
      assert.equal(oauthTokenSecretConfigured(), false);
      process.env.OAUTH_TOKEN_SECRET = 'short';
      assert.equal(oauthTokenSecretConfigured(), false);
    } finally {
      process.env.OAUTH_TOKEN_SECRET = prev;
    }
  });

  test('createAccessToken throws if secret missing or too short', () => {
    const prev = process.env.OAUTH_TOKEN_SECRET;
    try {
      delete process.env.OAUTH_TOKEN_SECRET;
      assert.throws(
        () => createAccessToken({ id: 'u', email: 'a@b', name: 'A' }, 's'),
        /OAUTH_TOKEN_SECRET/
      );
      process.env.OAUTH_TOKEN_SECRET = 'too-short';
      assert.throws(
        () => createAccessToken({ id: 'u', email: 'a@b', name: 'A' }, 's'),
        /OAUTH_TOKEN_SECRET/
      );
    } finally {
      process.env.OAUTH_TOKEN_SECRET = prev;
    }
  });
});

describe('generateAuthUrl — PKCE compliance', () => {
  test('includes code_challenge and code_challenge_method=S256', () => {
    const { url, sessionId } = generateAuthUrl();
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.ok(parsed.searchParams.get('code_challenge'), 'code_challenge must be present');
    assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(parsed.searchParams.get('response_type'), 'code');
    assert.ok(parsed.searchParams.get('state'), 'state must be present');
    assert.ok(sessionId, 'sessionId must be returned');
  });

  test('produces a different state and sessionId on each call', () => {
    const a = generateAuthUrl();
    const b = generateAuthUrl();
    assert.notEqual(a.sessionId, b.sessionId);
    const stateA = new URL(a.url).searchParams.get('state');
    const stateB = new URL(b.url).searchParams.get('state');
    assert.notEqual(stateA, stateB);
  });

  test('throws if GOOGLE_CLIENT_ID is unset', () => {
    const prev = process.env.GOOGLE_CLIENT_ID;
    try {
      delete process.env.GOOGLE_CLIENT_ID;
      assert.throws(() => generateAuthUrl(), /GOOGLE_CLIENT_ID/);
    } finally {
      process.env.GOOGLE_CLIENT_ID = prev;
    }
  });
});
