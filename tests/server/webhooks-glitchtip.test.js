// tests/server/webhooks-glitchtip.test.js
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  verifySignature,
  deriveFingerprint,
  buildContent
} from '../../src/server/webhooks-glitchtip.js';

describe('webhooks-glitchtip', () => {
  describe('verifySignature', () => {
    const secret = 'test-secret-123';

    it('returns true for a valid raw-hex signature', () => {
      const body = Buffer.from('{"action":"created"}');
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
      expect(verifySignature(body, sig, secret)).toBe(true);
    });

    it('also accepts the sha256= prefix used by some signers', () => {
      const body = Buffer.from('{"action":"created"}');
      const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
      expect(verifySignature(body, sig, secret)).toBe(true);
    });

    it('returns false for a tampered payload', () => {
      const body = Buffer.from('{"action":"created"}');
      const sig = crypto.createHmac('sha256', secret)
        .update(Buffer.from('{"action":"resolved"}'))
        .digest('hex');
      expect(verifySignature(body, sig, secret)).toBe(false);
    });

    it('returns false when signature is missing', () => {
      const body = Buffer.from('{}');
      expect(verifySignature(body, undefined, secret)).toBe(false);
      expect(verifySignature(body, null, secret)).toBe(false);
      expect(verifySignature(body, '', secret)).toBe(false);
    });

    it('returns false when secret is missing', () => {
      const body = Buffer.from('{}');
      expect(verifySignature(body, 'abc', undefined)).toBe(false);
      expect(verifySignature(body, 'abc', '')).toBe(false);
    });

    it('returns false for mismatched length signatures', () => {
      const body = Buffer.from('{}');
      expect(verifySignature(body, 'short', 'k')).toBe(false);
    });
  });

  describe('deriveFingerprint', () => {
    it('hashes a fingerprint array', () => {
      const fp = deriveFingerprint({ fingerprint: ['{{ default }}', 'TypeError'] });
      expect(fp).toMatch(/^[0-9a-f]{32}$/);
    });

    it('is stable across calls with the same input', () => {
      const a = deriveFingerprint({ fingerprint: ['x', 'y'] });
      const b = deriveFingerprint({ fingerprint: ['x', 'y'] });
      expect(a).toBe(b);
    });

    it('differs when the fingerprint differs', () => {
      const a = deriveFingerprint({ fingerprint: ['x'] });
      const b = deriveFingerprint({ fingerprint: ['y'] });
      expect(a).not.toBe(b);
    });

    it('falls back to issue.id when fingerprint is absent', () => {
      const fp = deriveFingerprint({ id: 4242 });
      expect(fp).toMatch(/^[0-9a-f]{32}$/);
    });

    it('returns null when nothing usable is present', () => {
      expect(deriveFingerprint({})).toBeNull();
      expect(deriveFingerprint({ fingerprint: [] })).toBeNull();
      expect(deriveFingerprint({ fingerprint: '' })).toBeNull();
    });

    it('accepts a string fingerprint', () => {
      const fp = deriveFingerprint({ fingerprint: 'unique-key' });
      expect(fp).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('buildContent', () => {
    it('returns the title alone when no other detail is present', () => {
      const c = buildContent({ title: 'TypeError: foo' });
      expect(c).toBe('TypeError: foo');
    });

    it('joins title + culprit', () => {
      const c = buildContent({ title: 'Boom', culprit: 'app/main.js in handler' });
      expect(c).toContain('Boom');
      expect(c).toContain('at app/main.js in handler');
    });

    it('includes a stack trace when frames are present', () => {
      const c = buildContent({
        title: 'Boom',
        exception: {
          values: [{
            stacktrace: {
              frames: [
                { filename: 'lib/a.js', function: 'a', lineno: 10 },
                { filename: 'lib/b.js', function: 'b', lineno: 20 }
              ]
            }
          }]
        }
      });
      expect(c).toContain('--- stack trace ---');
      // top-of-stack first (we reversed the array)
      expect(c.indexOf('at b ')).toBeLessThan(c.indexOf('at a '));
    });

    it('truncates an oversized stack trace', () => {
      const huge = Array.from({ length: 500 }, (_, i) => ({
        filename: 'lib/big.js',
        function: 'fn' + i,
        lineno: i,
        context_line: 'x'.repeat(80)
      }));
      const c = buildContent({
        title: 'Boom',
        exception: { values: [{ stacktrace: { frames: huge } }] }
      });
      // The trace section, sliced out, should not exceed our cap (4096 + the …).
      const sectionStart = c.indexOf('--- stack trace ---');
      const section = c.slice(sectionStart);
      expect(section.length).toBeLessThan(4500);
      expect(section.endsWith('…')).toBe(true);
    });

    it('includes recent breadcrumbs when present', () => {
      const c = buildContent({
        title: 'Boom',
        breadcrumbs: {
          values: [
            { timestamp: 1700000000, category: 'http', message: 'GET /api/x' },
            { timestamp: 1700000010, category: 'click', message: '<button>save</button>' }
          ]
        }
      });
      expect(c).toContain('--- breadcrumbs ---');
      expect(c).toContain('GET /api/x');
      expect(c).toContain('<button>save</button>');
    });
  });
});
