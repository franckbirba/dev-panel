// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootstrapWidgetSession, clearStoredSession, SESSION_STORAGE_KEY } from '../../src/react/chat/sessionId.js';

function fakeFetchOk(body) {
  return vi.fn(async () => ({ ok: true, status: 201, json: async () => body }));
}

describe('bootstrapWidgetSession', () => {
  beforeEach(() => {
    localStorage.clear();
    clearStoredSession();
  });

  it('POSTs to /api/widget/sessions and caches the bearer', async () => {
    const fetchImpl = fakeFetchOk({
      session_id: 'ws_aaa', session_token: 'wt_bbb', thread_id: 7,
      token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const out = await bootstrapWidgetSession({
      apiUrl: 'http://api', apiKey: 'k', fetchImpl,
    });
    expect(out.session_id).toBe('ws_aaa');
    expect(out.session_token).toBe('wt_bbb');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://api/api/widget/sessions');
    expect(init.method).toBe('POST');
    expect(init.headers['X-API-Key']).toBe('k');

    const stored = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY));
    expect(stored.session_id).toBe('ws_aaa');
    expect(stored.session_token).toBe('wt_bbb');
  });

  it('reuses a fresh cached session without hitting the network', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      session_id: 'ws_x', session_token: 'wt_x', thread_id: 1,
      token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }));
    const fetchImpl = vi.fn();
    const out = await bootstrapWidgetSession({ apiUrl: 'http://api', apiKey: 'k', fetchImpl });
    expect(out.session_id).toBe('ws_x');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('re-bootstraps when the cached token is near expiry', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      session_id: 'ws_old', session_token: 'wt_old',
      token_expires_at: new Date(Date.now() + 1000).toISOString(),
    }));
    const fetchImpl = fakeFetchOk({
      session_id: 'ws_new', session_token: 'wt_new', thread_id: 2,
      token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const out = await bootstrapWidgetSession({ apiUrl: 'http://api', apiKey: 'k', fetchImpl });
    expect(out.session_id).toBe('ws_new');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('throws when the server rejects the bootstrap', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    await expect(bootstrapWidgetSession({ apiUrl: 'http://api', apiKey: 'k', fetchImpl }))
      .rejects.toThrow(/401/);
  });
});
