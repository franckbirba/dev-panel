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

describe('ChatDrawer', () => {
  let fetchMock;

  beforeEach(() => {
    localStorage.clear();
    FakeES.last = null;
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: 'cap_1' }),
    }));
    global.fetch = fetchMock;
  });

  afterEach(() => cleanup());

  function renderDrawer(props = {}) {
    return render(
      <ChatDrawer
        apiUrl="http://test"
        apiKey="dp_test"
        sessionId="s_test"
        EventSource={FakeES}
        {...props}
      />,
    );
  }

  it('drawer is closed by default and toggles open on the chat button', () => {
    renderDrawer();
    expect(screen.queryByPlaceholderText(/écris/i)).toBeNull();
    fireEvent.click(screen.getByLabelText(/open chat/i));
    expect(screen.queryByPlaceholderText(/écris/i)).not.toBeNull();
  });

  it('persists drawer open state across remounts', () => {
    const { unmount } = renderDrawer();
    fireEvent.click(screen.getByLabelText(/open chat/i));
    expect(screen.queryByPlaceholderText(/écris/i)).not.toBeNull();
    unmount();
    renderDrawer();
    expect(screen.queryByPlaceholderText(/écris/i)).not.toBeNull();
  });

  it('persists message history across remounts', () => {
    const { unmount } = renderDrawer();
    fireEvent.click(screen.getByLabelText(/open chat/i));
    act(() => { FakeES.last.open(); });
    act(() => {
      FakeES.last.msg({ type: 'message', id: 'm1', role: 'shelly', content: 'salut', ts: 1 });
    });
    expect(screen.queryByText('salut')).not.toBeNull();
    unmount();

    renderDrawer();
    // Drawer stayed open through persistence; rehydrated history shows.
    expect(screen.queryByText('salut')).not.toBeNull();
  });

  it('clicking "Reporter un bug" pre-fills the compose box and shows a bug-mode badge', () => {
    renderDrawer();
    fireEvent.click(screen.getByLabelText(/open chat/i));
    fireEvent.click(screen.getByRole('button', { name: /reporter un bug/i }));
    const ta = screen.getByPlaceholderText(/écris/i);
    expect(ta.value.length).toBeGreaterThan(0);
    expect(screen.queryByText(/mode bug/i)).not.toBeNull();
  });

  it('submits a bug capture when send is clicked in bug mode', async () => {
    renderDrawer();
    fireEvent.click(screen.getByLabelText(/open chat/i));
    fireEvent.click(screen.getByRole('button', { name: /reporter un bug/i }));
    const ta = screen.getByPlaceholderText(/écris/i);
    fireEvent.change(ta, { target: { value: 'pagination dashboard cassée' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      const captureCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/api/captures'));
      expect(captureCall).toBeDefined();
      const body = JSON.parse(captureCall[1].body);
      expect(body.kind).toBe('bug');
      expect(body.content).toContain('pagination dashboard');
    });
  });

  it('renders shelly typing indicator from SSE typing events', () => {
    renderDrawer();
    fireEvent.click(screen.getByLabelText(/open chat/i));
    act(() => { FakeES.last.open(); });
    act(() => { FakeES.last.msg({ type: 'typing', value: true }); });
    expect(screen.queryByText(/shelly écrit/i)).not.toBeNull();
  });

  it('renders incoming Shelly messages from SSE', () => {
    renderDrawer();
    fireEvent.click(screen.getByLabelText(/open chat/i));
    act(() => { FakeES.last.open(); });
    act(() => {
      FakeES.last.msg({ type: 'message', id: 'm1', role: 'shelly', content: 'bonjour', ts: 1 });
      FakeES.last.msg({ type: 'message', id: 'm2', role: 'shelly', content: 'comment ça va', ts: 2 });
    });
    expect(screen.queryByText('bonjour')).not.toBeNull();
    expect(screen.queryByText('comment ça va')).not.toBeNull();
  });
});
