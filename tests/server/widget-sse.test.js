import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  subscribeWidgetSession,
  publishToWidgetSession,
  widgetSessionSubscriberCount,
  _resetWidgetSseForTests
} from '../../src/server/widget-sse.js';

// Fake express response object for SSE: captures writeHead + write calls
// and emits 'close'/'error' to drive cleanup.
function fakeRes() {
  const ee = new EventEmitter();
  ee.headers = null;
  ee.body = '';
  ee.writeHead = (status, headers) => { ee.status = status; ee.headers = headers; };
  ee.write = (chunk) => { ee.body += chunk; return true; };
  ee.end = () => ee.emit('close');
  return ee;
}

describe('widget-sse pool', () => {
  beforeEach(() => { _resetWidgetSseForTests(); });
  afterEach(() => { _resetWidgetSseForTests(); });

  it('subscribe writes SSE headers + ready event when no buffer', () => {
    const res = fakeRes();
    subscribeWidgetSession('ws_xyz', res);
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(res.headers['X-Accel-Buffering']).toBe('no');
    expect(res.body).toContain('event: ready');
    expect(widgetSessionSubscriberCount('ws_xyz')).toBe(1);
  });

  it('publish to a session with a live subscriber delivers in real time', () => {
    const res = fakeRes();
    subscribeWidgetSession('ws_xyz', res);
    res.body = ''; // clear after ready
    const result = publishToWidgetSession('ws_xyz', 'message', { hello: 'world' });
    expect(result.delivered).toBe(1);
    expect(result.buffered).toBe(0);
    expect(res.body).toContain('event: message');
    expect(res.body).toContain('"hello":"world"');
  });

  it('publish without subscribers buffers, then drains BEFORE ready on subscribe', () => {
    const r1 = publishToWidgetSession('ws_late', 'message', { n: 1 });
    const r2 = publishToWidgetSession('ws_late', 'message', { n: 2 });
    expect(r1.delivered).toBe(0);
    expect(r1.buffered).toBe(1);
    expect(r2.buffered).toBe(2);

    const res = fakeRes();
    subscribeWidgetSession('ws_late', res);
    // Body should have buffered messages BEFORE the ready event.
    const idxN1   = res.body.indexOf('"n":1');
    const idxN2   = res.body.indexOf('"n":2');
    const idxRdy  = res.body.indexOf('event: ready');
    expect(idxN1).toBeGreaterThan(0);
    expect(idxN2).toBeGreaterThan(idxN1);
    expect(idxRdy).toBeGreaterThan(idxN2);
  });

  it('multi-subscriber: both tabs receive the same publish', () => {
    const a = fakeRes(), b = fakeRes();
    subscribeWidgetSession('ws_multi', a);
    subscribeWidgetSession('ws_multi', b);
    a.body = ''; b.body = '';
    const r = publishToWidgetSession('ws_multi', 'message', { x: 'y' });
    expect(r.delivered).toBe(2);
    expect(a.body).toContain('"x":"y"');
    expect(b.body).toContain('"x":"y"');
  });

  it('cleanup on res close: subscriber count drops', () => {
    const res = fakeRes();
    subscribeWidgetSession('ws_close', res);
    expect(widgetSessionSubscriberCount('ws_close')).toBe(1);
    res.emit('close');
    expect(widgetSessionSubscriberCount('ws_close')).toBe(0);
  });

  it('emits ping events on heartbeat interval', () => {
    vi.useFakeTimers();
    const res = fakeRes();
    subscribeWidgetSession('ws_hb', res);
    res.body = '';
    vi.advanceTimersByTime(25_000);
    expect(res.body).toContain('event: ping');
    vi.useRealTimers();
  });
});
