// tests/server/webhooks-github.test.js
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  verifySignature,
  extractPlaneRef,
  syntheticWorkItemId
} from '../../src/server/webhooks-github.js';

describe('webhooks-github', () => {
  describe('verifySignature', () => {
    const secret = 'test-secret-123';

    it('returns true for valid HMAC SHA256 signature', () => {
      const body = Buffer.from('{"action":"opened"}');
      const sig = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(body)
        .digest('hex');
      expect(verifySignature(body, sig, secret)).toBe(true);
    });

    it('returns false for tampered payload', () => {
      const body = Buffer.from('{"action":"opened"}');
      const sig = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(Buffer.from('{"action":"closed"}'))
        .digest('hex');
      expect(verifySignature(body, sig, secret)).toBe(false);
    });

    it('returns false when signature is missing', () => {
      const body = Buffer.from('{}');
      expect(verifySignature(body, undefined, secret)).toBe(false);
      expect(verifySignature(body, null, secret)).toBe(false);
    });

    it('returns false when secret is missing', () => {
      const body = Buffer.from('{}');
      expect(verifySignature(body, 'sha256=abc', undefined)).toBe(false);
    });

    it('returns false for mismatched length signatures', () => {
      const body = Buffer.from('{}');
      expect(verifySignature(body, 'sha256=short', secret)).toBe(false);
    });
  });

  describe('extractPlaneRef', () => {
    it('matches UUID-based branch convention', () => {
      const ref = extractPlaneRef(
        'feat/wi-7096cee4-889b-403d-b924-2ad2dfbf371c-github-pr-webhook',
        'some title'
      );
      expect(ref).toEqual({
        type: 'uuid',
        value: '7096cee4-889b-403d-b924-2ad2dfbf371c'
      });
    });

    it('matches DEVPA-NNN branch convention', () => {
      const ref = extractPlaneRef('devpa-93-fix-capture-routing', null);
      expect(ref).toEqual({ type: 'sequence', project: 'DEVPA', number: 93 });
    });

    it('matches ZENO-NNN branch convention', () => {
      const ref = extractPlaneRef('zeno-42-pagination-fix', null);
      expect(ref).toEqual({ type: 'sequence', project: 'ZENO', number: 42 });
    });

    it('matches EDMS-NNN branch convention', () => {
      const ref = extractPlaneRef('edms-17-upload-retry', null);
      expect(ref).toEqual({ type: 'sequence', project: 'EDMS', number: 17 });
    });

    it('falls back to PR title when branch does not match', () => {
      const ref = extractPlaneRef('feature/random-branch', 'Fix DEVPA-153 merge coordinator');
      expect(ref).toEqual({ type: 'sequence', project: 'DEVPA', number: 153 });
    });

    it('returns null when nothing matches', () => {
      expect(extractPlaneRef('main', 'random title')).toBeNull();
      expect(extractPlaneRef(null, null)).toBeNull();
    });

    it('prefers branch UUID over title sequence', () => {
      const ref = extractPlaneRef(
        'feat/wi-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-slug',
        'DEVPA-99 something'
      );
      expect(ref.type).toBe('uuid');
    });
  });

  describe('syntheticWorkItemId', () => {
    it('generates deterministic ID from repo + PR number', () => {
      expect(syntheticWorkItemId('franckbirba/dev-panel', 17))
        .toBe('github:franckbirba/dev-panel#17');
    });
  });
});
