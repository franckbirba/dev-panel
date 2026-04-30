import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatSSEClient } from '../../src/react/chat/ChatSSEClient.js';

class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    FakeEventSource.instances.push(this);
  }
  close() { this.closed = true; this.readyState = 2; }
  fakeOpen() { this.readyState = 1; this.onopen?.(); }
  fakeMessage(data) { this.onmessage?.({ data }); }
  fakeError() { this.onerror?.({}); }
}

describe('ChatSSEClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects and reports open status', () => {
    const onStatus = vi.fn();
    const c = new ChatSSEClient({
      url: '/api/widget/sessions/s1/stream',
      EventSource: FakeEventSource,
      onStatus,
    });
    c.connect();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe('/api/widget/sessions/s1/stream');
    expect(onStatus).toHaveBeenCalledWith('connecting');
    FakeEventSource.instances[0].fakeOpen();
    expect(onStatus).toHaveBeenCalledWith('open');
  });

  it('parses JSON messages and forwards them to onMessage', () => {
    const onMessage = vi.fn();
    const c = new ChatSSEClient({ url: '/api', EventSource: FakeEventSource, onMessage });
    c.connect();
    FakeEventSource.instances[0].fakeMessage(JSON.stringify({ type: 'message', id: 'm1' }));
    expect(onMessage).toHaveBeenCalledWith({ type: 'message', id: 'm1' });
  });

  it('ignores non-JSON payloads silently', () => {
    const onMessage = vi.fn();
    const c = new ChatSSEClient({ url: '/api', EventSource: FakeEventSource, onMessage });
    c.connect();
    expect(() => FakeEventSource.instances[0].fakeMessage('keepalive')).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('reconnects with exponential backoff capped at 30s', () => {
    const onStatus = vi.fn();
    const c = new ChatSSEClient({ url: '/api', EventSource: FakeEventSource, onStatus });
    c.connect();
    const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const delay of expectedDelays) {
      const before = FakeEventSource.instances.length;
      FakeEventSource.instances.at(-1).fakeError();
      vi.advanceTimersByTime(delay - 1);
      expect(FakeEventSource.instances.length).toBe(before);
      vi.advanceTimersByTime(1);
      expect(FakeEventSource.instances.length).toBe(before + 1);
    }
    expect(onStatus).toHaveBeenCalledWith('reconnecting');
  });

  it('resets backoff after a successful open', () => {
    const c = new ChatSSEClient({ url: '/api', EventSource: FakeEventSource });
    c.connect();
    FakeEventSource.instances[0].fakeError();
    vi.advanceTimersByTime(1000);
    FakeEventSource.instances[1].fakeOpen();
    FakeEventSource.instances[1].fakeError();
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('disconnect stops further reconnect attempts and closes the stream', () => {
    const c = new ChatSSEClient({ url: '/api', EventSource: FakeEventSource });
    c.connect();
    FakeEventSource.instances[0].fakeError();
    c.disconnect();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });
});
