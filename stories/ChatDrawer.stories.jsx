import React, { useEffect } from 'react';
import { ChatDrawer } from '../src/react/chat/ChatDrawer.jsx';

// Mock SSE: lets stories drive the drawer without a backend. Each instance is
// captured in `instances[]` so the story body can push messages from outside.
function makeMockSSE(instances) {
  return class {
    constructor(url) {
      this.url = url;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      instances.push(this);
      setTimeout(() => this.onopen?.(), 30);
    }
    close() { /* no-op */ }
    push(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  };
}

function clearStoryStorage(sessionId) {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.removeItem(`devpanel.widget.chat.${sessionId}`); } catch { /* ignore */ }
}

// Stub fetch — Storybook stories shouldn't hit any real backend even if the
// user clicks "Reporter un bug". We swap fetch in/out per-render.
function withStubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

export default {
  title: 'devpanel/widget/ChatDrawer',
  component: ChatDrawer,
};

export const Empty = () => {
  useEffect(() => clearStoryStorage('sb_empty'), []);
  const instances = [];
  return (
    <ChatDrawer
      apiUrl="http://mock.local"
      apiKey="sb_key"
      sessionId="sb_empty"
      EventSource={makeMockSSE(instances)}
    />
  );
};

export const WithGreeting = () => {
  const instances = [];
  const SSE = makeMockSSE(instances);

  useEffect(() => {
    clearStoryStorage('sb_greeting');
    const restoreFetch = withStubFetch(async () => ({ ok: true, status: 201, json: async () => ({ id: 'cap_demo' }) }));

    const t1 = setTimeout(() => {
      instances.at(-1)?.push({
        type: 'message',
        id: 'm1',
        role: 'shelly',
        content: "Salut, je suis Shelly. En quoi je peux t'aider ?",
        ts: Date.now(),
      });
    }, 600);

    const t2 = setTimeout(() => {
      instances.at(-1)?.push({ type: 'typing', value: true });
    }, 2000);

    const t3 = setTimeout(() => {
      instances.at(-1)?.push({
        type: 'message',
        id: 'm2',
        role: 'shelly',
        content: "Si tu vois un bug, clique sur 'Reporter un bug' — j'attache automatiquement le contexte.",
        ts: Date.now(),
      });
    }, 3500);

    return () => {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
      restoreFetch();
    };
  }, []);

  return (
    <ChatDrawer
      apiUrl="http://mock.local"
      apiKey="sb_key"
      sessionId="sb_greeting"
      EventSource={SSE}
    />
  );
};

export const Reconnecting = () => {
  const instances = [];
  // EventSource that fires onerror right after construction → drawer goes
  // through the reconnect path so the status pill in the header reads
  // "reconnecting".
  class FlakySSE {
    constructor(url) {
      this.url = url; this.onopen = null; this.onmessage = null; this.onerror = null;
      instances.push(this);
      setTimeout(() => this.onerror?.({}), 30);
    }
    close() { /* no-op */ }
  }

  useEffect(() => clearStoryStorage('sb_reconnect'), []);

  return (
    <ChatDrawer
      apiUrl="http://mock.local"
      apiKey="sb_key"
      sessionId="sb_reconnect"
      EventSource={FlakySSE}
    />
  );
};
