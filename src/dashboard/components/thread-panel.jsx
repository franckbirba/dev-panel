// src/dashboard/components/thread-panel.jsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { subscribeAdminEvents } from '@/lib/events';
import { getAdminKey } from '@/lib/projects-store';

function timeAgo(iso) {
  if (!iso) return '\u2014';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const ROLE_STYLE = {
  user: 'bg-foreground text-background',
  shelly: 'bg-info/15 text-foreground border border-info/30',
  system: 'bg-secondary/50 text-muted-foreground italic',
  agent: 'bg-warning/15 text-foreground border border-warning/30',
};

export function ThreadPanel({ subject, apiUrl, apiKey, onClose }) {
  const [thread, setThread] = useState(null);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef(null);
  const endRef = useRef(null);

  const loadThread = useCallback(async () => {
    if (!subject) return;
    try {
      const r = await fetch(`${apiUrl}/api/threads/${subject.subject_type}/${subject.subject_id}`, {
        headers: { 'X-API-Key': apiKey }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setThread(data.thread);
      setMessages(data.messages || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [apiUrl, apiKey, subject]);

  useEffect(() => { loadThread(); }, [loadThread]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // SSE live messages
  useEffect(() => {
    const adminKey = getAdminKey();
    if (!adminKey || !thread) return;
    const unsub = subscribeAdminEvents(adminKey, (type, data) => {
      if (type === 'thread:message' && data.thread_id === thread.thread_id) {
        setMessages(prev => {
          if (prev.some(m => m.id === data.message.id)) return prev;
          return [...prev, data.message];
        });
      }
    });
    return unsub;
  }, [thread]);

  async function handleSend(e) {
    e.preventDefault();
    const content = inputRef.current?.value.trim();
    if (!content || !subject) return;
    setSending(true);
    try {
      await fetch(`${apiUrl}/api/threads/${subject.subject_type}/${subject.subject_id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ content, role: 'user', source: 'web' })
      });
      inputRef.current.value = '';
      await loadThread();
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend(e);
    }
  }

  if (!subject) return null;

  return (
    <div className="w-full md:w-[40%] md:min-w-[360px] md:max-w-[560px] fixed md:relative inset-0 md:inset-auto border-l border-border flex flex-col bg-background h-full z-30">
      {/* Header */}
      <div className="px-5 py-3 border-b border-border flex items-center gap-3">
        <button onClick={onClose}
          className="md:hidden text-muted-foreground hover:text-foreground cursor-pointer text-xs mr-2">{'\u2190'} back</button>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate">{subject.title || `${subject.subject_type}/${subject.subject_id}`}</div>
          <div className="text-[10px] text-muted-foreground/60 font-mono mt-0.5">
            {subject.project_name || ''} {'\u00B7'} {subject.subject_type}
          </div>
        </div>
        <button onClick={onClose}
          className="hidden md:block text-muted-foreground hover:text-foreground cursor-pointer text-sm">{'\u2715'}</button>
      </div>

      {error && (
        <div className="px-5 py-2 text-[11px] text-error bg-error/5 border-b border-error/20 font-mono">{error}</div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {messages.map(m => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-lg px-3 py-2 text-xs ${ROLE_STYLE[m.role] || ROLE_STYLE.system}`}>
              {m.role !== 'user' && (
                <div className="text-[10px] font-mono uppercase tracking-wider opacity-60 mb-1">{m.role}</div>
              )}
              <div className="whitespace-pre-wrap">{m.content}</div>
              <div className="text-[10px] opacity-50 mt-1 font-mono">{timeAgo(m.created_at)}</div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Reply box */}
      <form onSubmit={handleSend} className="border-t border-border px-5 py-3 flex items-center gap-2">
        <input
          ref={inputRef}
          onKeyDown={handleKeyDown}
          placeholder="reply to shelly\u2026 (Cmd+Enter to send)"
          className="flex-1 h-9 px-3 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring/60"
        />
        <button type="submit" disabled={sending}
          className="h-9 px-3 rounded-md bg-foreground text-background text-xs font-medium disabled:opacity-50 cursor-pointer">
          send
        </button>
      </form>
    </div>
  );
}
