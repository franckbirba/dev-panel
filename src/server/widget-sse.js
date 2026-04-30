// src/server/widget-sse.js
//
// Per-session SSE pool with offline buffer. Each widget session_id maps to
// a Set of live res streams (multiple browser tabs) plus a small in-memory
// ring of payloads that arrived while no subscriber was connected.
//
// On subscribe, the buffer drains BEFORE the `ready` event so the client
// sees every queued message in order then knows the live stream has begun.
// On disconnect (close/error), the res is removed and the heartbeat stops.

const subscribers = new Map(); // session_id → Set<res>
const buffers     = new Map(); // session_id → Array<{event, data}>

const HEARTBEAT_MS = 25000; // < typical 30s nginx idle timeout
const BUFFER_LIMIT = parseInt(process.env.WIDGET_SESSION_BUFFER_LIMIT || '50', 10);

function writeEvent(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

// Subscribe the given res to a session. Writes SSE headers, drains any
// buffered messages, then emits `ready`. Returns void; cleanup is wired
// to res 'close' and 'error'.
export function subscribeWidgetSession(session_id, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(':\n\n'); // flush headers

  // Drain buffered events first.
  const pending = buffers.get(session_id);
  if (pending && pending.length) {
    for (const evt of pending) writeEvent(res, evt.event, evt.data);
    buffers.delete(session_id);
  }

  // Then ready.
  writeEvent(res, 'ready', { session_id, ts: new Date().toISOString() });

  let set = subscribers.get(session_id);
  if (!set) { set = new Set(); subscribers.set(session_id, set); }
  set.add(res);

  const hb = setInterval(() => {
    const ok = writeEvent(res, 'ping', { ts: new Date().toISOString() });
    if (!ok) cleanup();
  }, HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(hb);
    const s = subscribers.get(session_id);
    if (s) {
      s.delete(res);
      if (s.size === 0) subscribers.delete(session_id);
    }
  };

  res.on('close', cleanup);
  res.on('error', cleanup);
}

// Publish a payload to all subscribers of a session. If none, push onto
// the per-session buffer (capped — oldest dropped). Returns
// {delivered, buffered, dropped} so callers can log delivery state.
export function publishToWidgetSession(session_id, event, data) {
  const set = subscribers.get(session_id);
  if (set && set.size > 0) {
    let delivered = 0;
    for (const res of set) {
      if (writeEvent(res, event, data)) delivered++;
    }
    return { delivered, buffered: 0, dropped: 0 };
  }
  // No live subscriber — buffer.
  let arr = buffers.get(session_id);
  if (!arr) { arr = []; buffers.set(session_id, arr); }
  arr.push({ event, data });
  let dropped = 0;
  while (arr.length > BUFFER_LIMIT) { arr.shift(); dropped++; }
  return { delivered: 0, buffered: arr.length, dropped };
}

export function widgetSessionSubscriberCount(session_id) {
  return subscribers.get(session_id)?.size ?? 0;
}

// Test helper — wipes both maps. Should be called between tests so
// state doesn't leak.
export function _resetWidgetSseForTests() {
  for (const set of subscribers.values()) {
    for (const res of set) {
      try { res.end(); } catch { /* socket already gone */ }
    }
  }
  subscribers.clear();
  buffers.clear();
}
