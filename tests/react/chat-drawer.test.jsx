// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { ChatDrawer } from '../../src/react/chat/ChatDrawer.jsx';

class FakeES {
  static last = null;
  constructor(url) {
    this.url = url;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.closed = false;
    FakeES.last = this;
  }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  msg(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

// Mock fetch dispatcher that recognizes bootstrap, captures, and messages
// endpoints. Keeps a fresh session per test via beforeEach.
function makeFetchMock() {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/widget/sessions')) {
      return {
        ok: true,
        status: 201,
        json: async () => ({
          session_id: 'srv_session',
          session_token: 'srv_token',
          thread_id: 1,
          token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      };
    }
    if (String(url).endsWith('/api/captures')) {
      return { ok: true, status: 201, json: async () => ({ id: 'cap_1' }) };
    }
    if (/\/api\/widget\/sessions\/[^/]+\/messages$/.test(String(url))) {
      return { ok: true, status: 202, json: async () => ({ message_id: 1 }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  fn.calls = calls;
  return fn;
}

async function openDrawer() {
  // Wait for bootstrap to resolve and the FAB to appear, then click it.
  await waitFor(() => expect(screen.queryByLabelText(/open chat/i)).not.toBeNull());
  fireEvent.click(screen.getByLabelText(/open chat/i));
}

describe('ChatDrawer', () => {
  let fetchMock;

  beforeEach(() => {
    localStorage.clear();
    FakeES.last = null;
    fetchMock = makeFetchMock();
    global.fetch = fetchMock;
  });

  afterEach(() => cleanup());

  function renderDrawer(props = {}) {
    return render(
      <ChatDrawer
        apiUrl="http://test"
        apiKey="dp_test"
        EventSource={FakeES}
        {...props}
      />,
    );
  }

  it('bootstraps a session and toggles drawer open on the chat button', async () => {
    renderDrawer();
    await waitFor(() => {
      const bootstrap = fetchMock.calls.find((c) => c.url.endsWith('/api/widget/sessions'));
      expect(bootstrap).toBeDefined();
    });
    expect(screen.queryByPlaceholderText(/écris/i)).toBeNull();
    await openDrawer();
    expect(screen.queryByPlaceholderText(/écris/i)).not.toBeNull();
  });

  it('opens the SSE stream with the server-issued bearer token', async () => {
    renderDrawer();
    await openDrawer();
    await waitFor(() => expect(FakeES.last).not.toBeNull());
    expect(FakeES.last.url).toContain('/api/widget/sessions/srv_session/stream');
    expect(FakeES.last.url).toContain('token=srv_token');
  });

  it('persists drawer open state across remounts', async () => {
    const { unmount } = renderDrawer();
    await openDrawer();
    expect(screen.queryByPlaceholderText(/écris/i)).not.toBeNull();
    unmount();
    renderDrawer();
    await waitFor(() => expect(screen.queryByPlaceholderText(/écris/i)).not.toBeNull());
  });

  it('persists message history across remounts', async () => {
    const { unmount } = renderDrawer();
    await openDrawer();
    await waitFor(() => expect(FakeES.last).not.toBeNull());
    act(() => { FakeES.last.open(); });
    act(() => {
      FakeES.last.msg({ type: 'message', id: 'm1', role: 'shelly', content: 'salut', ts: 1 });
    });
    expect(screen.queryByText('salut')).not.toBeNull();
    unmount();

    renderDrawer();
    await waitFor(() => expect(screen.queryByText('salut')).not.toBeNull());
  });

  it('clicking "Reporter un bug" pre-fills the compose box and shows a bug-mode badge', async () => {
    renderDrawer();
    await openDrawer();
    fireEvent.click(screen.getByRole('button', { name: /reporter un bug/i }));
    const ta = screen.getByPlaceholderText(/écris/i);
    expect(ta.value.length).toBeGreaterThan(0);
    expect(screen.queryByText(/mode bug/i)).not.toBeNull();
  });

  it('submits a bug capture when send is clicked in bug mode', async () => {
    renderDrawer();
    await openDrawer();
    fireEvent.click(screen.getByRole('button', { name: /reporter un bug/i }));
    const ta = screen.getByPlaceholderText(/écris/i);
    fireEvent.change(ta, { target: { value: 'pagination dashboard cassée' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      const captureCall = fetchMock.calls.find((c) => c.url.endsWith('/api/captures'));
      expect(captureCall).toBeDefined();
      const body = JSON.parse(captureCall.init.body);
      expect(body.kind).toBe('bug');
      expect(body.content).toContain('pagination dashboard');
    });
  });

  it('POSTs conversational messages with the per-session bearer', async () => {
    renderDrawer();
    await openDrawer();
    const ta = screen.getByPlaceholderText(/écris/i);
    fireEvent.change(ta, { target: { value: 'salut shelly' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => {
      const msgCall = fetchMock.calls.find((c) => /\/messages$/.test(c.url));
      expect(msgCall).toBeDefined();
      expect(msgCall.init.headers.Authorization).toBe('Bearer srv_token');
      const body = JSON.parse(msgCall.init.body);
      expect(body.content).toBe('salut shelly');
    });
  });

  it('renders shelly typing indicator from SSE typing events', async () => {
    renderDrawer();
    await openDrawer();
    await waitFor(() => expect(FakeES.last).not.toBeNull());
    act(() => { FakeES.last.open(); });
    act(() => { FakeES.last.msg({ type: 'typing', value: true }); });
    expect(screen.queryByText(/shelly écrit/i)).not.toBeNull();
  });

  it('renders incoming Shelly messages from SSE', async () => {
    renderDrawer();
    await openDrawer();
    await waitFor(() => expect(FakeES.last).not.toBeNull());
    act(() => { FakeES.last.open(); });
    act(() => {
      FakeES.last.msg({ type: 'message', id: 'm1', role: 'shelly', content: 'bonjour', ts: 1 });
      FakeES.last.msg({ type: 'message', id: 'm2', role: 'shelly', content: 'comment ça va', ts: 2 });
    });
    expect(screen.queryByText('bonjour')).not.toBeNull();
    expect(screen.queryByText('comment ça va')).not.toBeNull();
  });
});
