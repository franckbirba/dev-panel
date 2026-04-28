// src/dashboard/lib/live.js
// Single shared SSE subscription for the whole dashboard. Multiple views can
// register listeners for the same event type without spawning multiple
// EventSource connections — that's important because /api/events is gated
// per-API-key and Chrome caps to 6 concurrent SSE connections per origin.
//
// Server-side hooks (workflow-instances.js, jobs-log.js, captures POST,
// alerts.js notifyJob) all push through ./sse.js → /api/events. This module
// is the consumer side of that pipe: views call useLiveEvent(name, handler)
// and the handler fires whenever the server pushes a matching event.

import { useEffect, useRef } from 'react';

let _es = null;
let _refCount = 0;
const listeners = new Map(); // event_name → Set<handler>

function ensureConnection(apiUrl, apiKey) {
  if (_es) return;
  const u = `${apiUrl}/api/events?api_key=${encodeURIComponent(apiKey)}`;
  _es = new EventSource(u);
  _es.onopen = () => { /* connected */ };
  _es.onerror = () => {
    // EventSource auto-reconnects after error. If the server stays down we
    // close and let the next ensureConnection() spin a new one.
    if (_es && _es.readyState === EventSource.CLOSED) {
      _es = null;
    }
  };
  // Generic catch-all dispatcher: when a listener registers a new event
  // name we attach a fresh addEventListener for it (EventSource requires
  // per-name listeners — there's no wildcard).
}

function attachIfNeeded(eventName) {
  if (!_es || _es._attached?.has(eventName)) return;
  _es._attached = _es._attached || new Set();
  _es._attached.add(eventName);
  _es.addEventListener(eventName, (e) => {
    let payload;
    try { payload = JSON.parse(e.data); } catch { payload = e.data; }
    const set = listeners.get(eventName);
    if (set) for (const fn of set) {
      try { fn(payload); } catch (err) { console.warn('[live]', eventName, err); }
    }
  });
}

export function useLiveEvent(eventName, handler, { apiUrl, apiKey } = {}) {
  // useRef so the handler closure doesn't churn the listener set on every
  // render (which would also unsubscribe + resubscribe constantly).
  const handlerRef = useRef(handler);
  useEffect(() => { handlerRef.current = handler; }, [handler]);

  useEffect(() => {
    if (!apiKey) return;
    ensureConnection(apiUrl, apiKey);
    attachIfNeeded(eventName);
    const fn = (data) => handlerRef.current?.(data);
    let set = listeners.get(eventName);
    if (!set) { set = new Set(); listeners.set(eventName, set); }
    set.add(fn);
    _refCount++;
    return () => {
      set.delete(fn);
      _refCount--;
      // Close the shared connection only when no view is listening any more.
      if (_refCount === 0 && _es) {
        try { _es.close(); } catch { /* ignore */ }
        _es = null;
        listeners.clear();
      }
    };
  }, [eventName, apiUrl, apiKey]);
}
