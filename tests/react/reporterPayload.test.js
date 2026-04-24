import { describe, it, expect } from 'vitest';
import { buildCaptureRequestPayload } from '../../src/react/reporterPayload.js';

describe('buildCaptureRequestPayload', () => {
  it('includes reporter when user is a plain object', () => {
    const body = buildCaptureRequestPayload(
      { id: 'u_42', name: 'Alice', email: 'alice@zeno.com', role: 'pm' },
      'bug',
      'broken'
    );
    expect(body).toEqual({
      kind: 'bug',
      content: 'broken',
      reporter: { id: 'u_42', name: 'Alice', email: 'alice@zeno.com', role: 'pm' }
    });
  });

  it('omits reporter when user is null', () => {
    const body = buildCaptureRequestPayload(null, 'bug', 'broken');
    expect(body).toEqual({ kind: 'bug', content: 'broken' });
    expect('reporter' in body).toBe(false);
  });

  it('omits reporter when user is undefined', () => {
    const body = buildCaptureRequestPayload(undefined, 'feature', 'pls');
    expect('reporter' in body).toBe(false);
  });

  it('omits reporter when user is not a plain object (string)', () => {
    const body = buildCaptureRequestPayload('alice', 'bug', 'x');
    expect('reporter' in body).toBe(false);
  });

  it('omits reporter when user is an array', () => {
    const body = buildCaptureRequestPayload(['a'], 'bug', 'x');
    expect('reporter' in body).toBe(false);
  });
});
