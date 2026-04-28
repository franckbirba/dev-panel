import { useEffect, useRef } from 'react';
import { createChatStore } from './chatStore.js';
import { ChatSSEClient } from './ChatSSEClient.js';
import { postCapture } from '../captureFlow.js';

const BUG_TEMPLATE = 'Bug : \nÉtapes : \nRésultat : \nAttendu : ';

export function ChatDrawer({
  apiUrl,
  apiKey,
  sessionId,
  EventSource: EventSourceImpl,
  user = null,
  environment = null,
  getCaptureContext = null,
  position = 'bottom-right',
}) {
  // One store per (mount, sessionId). The ref keeps the same hook reference
  // across renders; sessionId changes are rare but we honour them.
  const storeRef = useRef(null);
  if (!storeRef.current || storeRef.current.__sid !== sessionId) {
    storeRef.current = createChatStore(sessionId);
    storeRef.current.__sid = sessionId;
  }
  const useStore = storeRef.current;

  const messages = useStore((s) => s.messages);
  const draft = useStore((s) => s.draft);
  const isOpen = useStore((s) => s.isOpen);
  const bugMode = useStore((s) => s.bugMode);
  const typing = useStore((s) => s.typing);
  const connectionStatus = useStore((s) => s.connectionStatus);

  // Open drawer ⇒ open SSE stream. Close drawer ⇒ tear it down.
  useEffect(() => {
    if (!isOpen || !apiUrl || !sessionId) return undefined;
    const ESImpl = EventSourceImpl
      ?? (typeof window !== 'undefined' ? window.EventSource : null);
    if (!ESImpl) return undefined;

    const url = `${apiUrl}/api/widget/sessions/${encodeURIComponent(sessionId)}/stream`;
    const client = new ChatSSEClient({
      url,
      EventSource: ESImpl,
      onStatus: (s) => useStore.getState().setConnectionStatus(s),
      onMessage: (event) => {
        const st = useStore.getState();
        if (event.type === 'message') {
          st.appendMessage({
            id: event.id ?? `srv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: event.role || 'shelly',
            content: event.content ?? '',
            ts: event.ts ?? Date.now(),
          });
          st.setTyping(false);
        } else if (event.type === 'typing') {
          st.setTyping(!!event.value);
        } else if (event.type === 'capture_ack') {
          st.appendMessage({
            id: `ack-${event.capture_id}`,
            role: 'system',
            content: event.message ?? `Capture #${event.capture_id} bien reçue.`,
            ts: Date.now(),
          });
        }
      },
    });
    client.connect();
    return () => client.disconnect();
  }, [isOpen, apiUrl, sessionId, EventSourceImpl, useStore]);

  const send = async () => {
    const st = useStore.getState();
    const text = (st.draft || '').trim();
    if (!text) return;
    const ts = Date.now();
    const localId = `u-${ts}-${Math.random().toString(36).slice(2, 8)}`;
    st.appendMessage({ id: localId, role: 'user', content: text, ts });
    st.setDraft('');

    if (st.bugMode) {
      const metadata = (typeof getCaptureContext === 'function' && getCaptureContext()) || {
        type: 'bug',
        url: typeof window !== 'undefined' ? window.location.href : null,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        viewport: typeof window !== 'undefined'
          ? { width: window.innerWidth, height: window.innerHeight } : null,
        timestamp: ts,
        source: 'widget-chat',
      };
      try {
        const capture = await postCapture({
          apiUrl, apiKey, user, environment, kind: 'bug', content: text, metadata,
        });
        useStore.getState().appendMessage({
          id: `sys-${ts}`,
          role: 'system',
          content: `Bug enregistré (capture #${capture.id}). Shelly va te répondre ici.`,
          ts: Date.now(),
        });
      } catch (err) {
        useStore.getState().appendMessage({
          id: `err-${ts}`,
          role: 'system',
          content: `Échec de l'envoi : ${err.message}`,
          ts: Date.now(),
        });
      }
      useStore.getState().setBugMode(false);
      return;
    }

    // Conversational message — fire-and-forget; SSE delivers Shelly's reply.
    try {
      await fetch(`${apiUrl}/api/widget/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ id: localId, content: text, ts }),
      });
    } catch {
      // Offline / network blip — user will retry; SSE reconnect handles the rest.
    }
  };

  const startBug = () => {
    const st = useStore.getState();
    st.setBugMode(true);
    if (!st.draft) st.setDraft(BUG_TEMPLATE);
  };

  const isRight = position === 'bottom-right';
  const sideKey = isRight ? 'right' : 'left';

  const toggleStyle = {
    position: 'fixed',
    bottom: '24px',
    [sideKey]: '80px',
    width: '48px',
    height: '48px',
    borderRadius: '50%',
    border: 'none',
    cursor: 'pointer',
    background: '#10b981',
    color: 'white',
    fontSize: '22px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
    zIndex: 99998,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const drawerStyle = {
    position: 'fixed',
    top: 0,
    [sideKey]: 0,
    bottom: 0,
    width: '360px',
    maxWidth: '92vw',
    background: '#1a1a2e',
    color: '#e6e6f0',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '-4px 0 16px rgba(0,0,0,0.3)',
    zIndex: 99998,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  };

  const bubbleStyle = (role) => ({
    display: 'inline-block',
    padding: '8px 12px',
    borderRadius: 12,
    background:
      role === 'user' ? '#6366f1'
      : role === 'system' ? '#374151'
      : '#2a2a4a',
    color: 'white',
    maxWidth: '85%',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: 13,
  });

  return (
    <>
      <button
        data-devtool-ignore
        type="button"
        aria-label="Open chat"
        style={toggleStyle}
        onClick={() => useStore.getState().toggleDrawer()}
      >
        💬
      </button>

      {isOpen && (
        <aside data-devtool-ignore style={drawerStyle}>
          <header style={{
            padding: '12px 16px',
            borderBottom: '1px solid #2a2a4a',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            <strong style={{ flex: 1 }}>Shelly</strong>
            <span style={{ fontSize: 11, opacity: 0.7 }}>{connectionStatus}</span>
            <button
              data-devtool-ignore
              type="button"
              aria-label="Close chat"
              onClick={() => useStore.getState().closeDrawer()}
              style={{
                background: 'none',
                border: 'none',
                color: '#e6e6f0',
                cursor: 'pointer',
                fontSize: 18,
                lineHeight: 1,
              }}
            >×</button>
          </header>

          <ul style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px 16px',
            margin: 0,
            listStyle: 'none',
          }}>
            {messages.map((m) => (
              <li
                key={m.id}
                style={{
                  margin: '6px 0',
                  textAlign: m.role === 'user' ? 'right' : 'left',
                }}
              >
                <span style={bubbleStyle(m.role)}>{m.content}</span>
              </li>
            ))}
            {typing && (
              <li style={{
                opacity: 0.7, fontSize: 12, fontStyle: 'italic', margin: '6px 0',
              }}>
                Shelly écrit…
              </li>
            )}
          </ul>

          {bugMode && (
            <div style={{
              padding: '6px 16px',
              fontSize: 11,
              color: '#fecaca',
              background: '#3f1d1d',
              borderTop: '1px solid #2a2a4a',
            }}>
              Mode bug — le prochain envoi ouvre une capture.
            </div>
          )}

          <div style={{ padding: '8px 16px 12px', borderTop: '1px solid #2a2a4a' }}>
            <textarea
              data-devtool-ignore
              value={draft}
              onChange={(e) => useStore.getState().setDraft(e.target.value)}
              placeholder="Écris à Shelly…"
              rows={3}
              style={{
                width: '100%',
                padding: 8,
                borderRadius: 8,
                border: '1px solid #2a2a4a',
                background: '#0f0f1a',
                color: '#e6e6f0',
                resize: 'vertical',
                fontSize: 13,
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, gap: 8 }}>
              <button
                data-devtool-ignore
                type="button"
                onClick={startBug}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: 'pointer',
                  background: bugMode ? '#7f1d1d' : '#ef4444',
                  color: 'white',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                🐛 Reporter un bug
              </button>
              <button
                data-devtool-ignore
                type="button"
                aria-label="Send"
                onClick={send}
                disabled={!draft.trim()}
                style={{
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: draft.trim() ? 'pointer' : 'not-allowed',
                  background: '#6366f1',
                  color: 'white',
                  fontSize: 13,
                  fontWeight: 600,
                  opacity: draft.trim() ? 1 : 0.5,
                }}
              >
                Envoyer
              </button>
            </div>
          </div>
        </aside>
      )}
    </>
  );
}
