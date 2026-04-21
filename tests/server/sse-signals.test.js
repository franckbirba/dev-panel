import { describe, it, expect, vi } from 'vitest';
import { broadcast } from '../../src/server/sse.js';

describe('sse: signal events', () => {
  it('broadcast accepts signal:new and subject:priority_changed event names', () => {
    expect(() => broadcast('signal:new', { subject_type: 'deploy', subject_id: 'abc' })).not.toThrow();
    expect(() => broadcast('subject:priority_changed', { subject_type: 'capture', subject_id: 'cap-1', priority: 'now' })).not.toThrow();
    expect(() => broadcast('thread:message', { thread_id: 1, message: { id: 1, role: 'user', content: 'hi' } })).not.toThrow();
  });
});
