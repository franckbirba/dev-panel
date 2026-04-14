// tests/worker/auth.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { assertAllowedRequester } from '../../src/worker/auth.js';

beforeEach(() => { process.env.DEPLOY_ALLOWED_REQUESTERS = 'franck,cron:nightly'; });

describe('assertAllowedRequester', () => {
  it('allows listed requesters', () => {
    expect(() => assertAllowedRequester('deploy', 'franck')).not.toThrow();
    expect(() => assertAllowedRequester('deploy', 'cron:nightly')).not.toThrow();
  });
  it('rejects others', () => {
    expect(() => assertAllowedRequester('deploy', 'pm')).toThrow(/not allowed/);
  });
  it('is a no-op for non-deploy agents', () => {
    expect(() => assertAllowedRequester('builder', 'pm')).not.toThrow();
  });
});
