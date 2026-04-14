// src/dashboard/lib/events.js
// Subscribe to the admin SSE stream at /api/admin/events.
// Uses fetch + ReadableStream because EventSource cannot send custom headers.
//
// Usage:
//   const unsub = subscribeAdminEvents(adminKey, (eventType, data) => { ... });
//   // later: unsub();

export function subscribeAdminEvents(adminKey, onEvent) {
  const url = `/api/admin/events`;
  const controller = new AbortController();
  (async () => {
    const res = await fetch(url, {
      headers: { 'X-Admin-Key': adminKey, Accept: 'text/event-stream' },
      signal: controller.signal
    });
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = frame.split('\n');
        let event = 'message', data = '';
        for (const l of lines) {
          if (l.startsWith('event: ')) event = l.slice(7).trim();
          if (l.startsWith('data: ')) data = l.slice(6);
        }
        if (event !== 'message' || data) {
          try { onEvent(event, data ? JSON.parse(data) : {}); }
          catch (e) { console.error('[events] parse error:', e); }
        }
      }
    }
  })().catch(err => {
    if (err.name !== 'AbortError') console.error('[events] stream error:', err);
  });
  return () => controller.abort();
}
