// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { getOrCreateSessionId, SESSION_STORAGE_KEY } from '../../src/react/chat/sessionId.js';

describe('chat sessionId', () => {
  beforeEach(() => localStorage.clear());

  it('generates a new session id when none exists', () => {
    const id = getOrCreateSessionId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(3);
  });

  it('returns the same id on subsequent calls', () => {
    const id1 = getOrCreateSessionId();
    const id2 = getOrCreateSessionId();
    expect(id1).toBe(id2);
  });

  it('persists the id in localStorage', () => {
    const id = getOrCreateSessionId();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe(id);
  });

  it('reuses an id already present in localStorage', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'ws_existing');
    expect(getOrCreateSessionId()).toBe('ws_existing');
  });
});
