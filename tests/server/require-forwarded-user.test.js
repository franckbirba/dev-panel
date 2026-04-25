import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { requireForwardedUser } from '../../src/server/middleware/require-forwarded-user.js';

function mkRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

describe('requireForwardedUser', () => {
  const original = process.env.TRUST_FORWARDED_USER;
  afterEach(() => {
    if (original === undefined) delete process.env.TRUST_FORWARDED_USER;
    else process.env.TRUST_FORWARDED_USER = original;
  });

  it('rejects with 401 when TRUST_FORWARDED_USER is not set', () => {
    delete process.env.TRUST_FORWARDED_USER;
    const req = { headers: { 'x-forwarded-user': 'someone@example.com' } };
    const res = mkRes();
    let nextCalled = false;
    requireForwardedUser(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/forwarded user/i);
  });

  it('rejects with 401 when X-Forwarded-User is missing', () => {
    process.env.TRUST_FORWARDED_USER = 'true';
    const req = { headers: {} };
    const res = mkRes();
    let nextCalled = false;
    requireForwardedUser(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('passes through and sets req.user when both are set', () => {
    process.env.TRUST_FORWARDED_USER = 'true';
    const req = { headers: { 'x-forwarded-user': 'franckbirba@gmail.com' } };
    const res = mkRes();
    let nextCalled = false;
    requireForwardedUser(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(req.user).toEqual({ type: 'forwarded_user', email: 'franckbirba@gmail.com' });
  });

  it('treats whitespace-only header as missing', () => {
    process.env.TRUST_FORWARDED_USER = 'true';
    const req = { headers: { 'x-forwarded-user': '   ' } };
    const res = mkRes();
    let nextCalled = false;
    requireForwardedUser(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
