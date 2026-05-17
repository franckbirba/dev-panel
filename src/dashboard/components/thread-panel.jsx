// src/dashboard/components/thread-panel.jsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { subscribeAdminEvents } from '@/lib/events';
import { getAdminKey } from '@/lib/projects-store';
import { IconClose, IconSend, IconArrowLeft } from './icons';
import { CaptureMetaPanel, CaptureScreenshot, parseMessageMetadata } from './capture-meta-panel';

// Import the ReactCanvas component
import { ReactCanvas } from './react-canvas';

function timeAgo(iso) {
  if (!iso) return '\u2014';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const ROLE_STYLE = {
  user: 'bg-brand/20 text-foreground border border-brand/20',
  shelly: 'bg-info/10 text-foreground border border-info/20',
  system: 'bg-white/[0.02] text-muted-foreground italic border border-border',
  agent: 'bg-warning/10 text-foreground border border-warning/20',
};

const ROLE_LABEL = { shelly: 'Shelly', agent: 'Agent', system: 'System' };

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
    <div className="w-full md:w-[40%] md:min-w-[360px] md:max-w-[560px] fixed md:relative inset-0 md:inset-auto border-l border-border flex flex-col bg-background/95 backdrop-blur-xl h-full z-30 animate-slide-in-right">
      {/* Header */}
      <div className="px-5 py-3.5 border-b border-border flex items-center gap-3 glass-surface">
        <button onClick={onClose}
          className="md:hidden text-muted-foreground hover:text-foreground cursor-pointer p-1 rounded-md hover:bg-white/5 transition-colors mr-1">
          <IconArrowLeft width={16} height={16} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium truncate">{subject.title || `${subject.subject_type}/${subject.subject_id}`}</div>
          <div className="text-[10px] text-muted-foreground/50 font-mono mt-0.5">
            {subject.project_name || ''} · {subject.subject_type}
          </div>
        </div>
        <button onClick={onClose}
          className="hidden md:flex items-center justify-center w-7 h-7 text-muted-foreground hover:text-foreground cursor-pointer rounded-md hover:bg-white/5 transition-colors">
          <IconClose width={15} height={15} />
        </button>
      </div>

      {error && (
        <div className="px-5 py-2 text-[11px] text-error bg-error/5 border-b border-error/20 font-mono">{error}</div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {messages.map((m, i) => {
          const meta = parseMessageMetadata(m.metadata);
          
          // Check if this message contains a react-canvas payload
          let reactCanvasPayload = null;
          if (meta && meta.parts) {
            const lastPart = meta.parts[meta.parts.length - 1];
            if (lastPart && lastPart.type === 'text') {
              try {
                const parsed = JSON.parse(lastPart.text);
                if (parsed.type === 'react-canvas') {
                  reactCanvasPayload = parsed;
                }
              } catch (e) {
                // Not a JSON payload, ignore
              }
            }
          }
          
          return (
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in-up`}
              style={{ animationDelay: `${Math.min(i * 0.03, 0.3)}s` }}>
              <div className={`max-w-[80%] rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed ${ROLE_STYLE[m.role] || ROLE_STYLE.system}`}>
                {m.role !== 'user' && (
                  <div className="text-[10px] font-mono uppercase tracking-wider opacity-50 mb-1">{ROLE_LABEL[m.role] || m.role}</div>
                )}
                <div className="whitespace-pre-wrap">{m.content}</div>
                {reactCanvasPayload && (
                  <div className="mt-3">
                    <ReactCanvas payload={reactCanvasPayload} />
                  </div>
                )}
                <CaptureScreenshot meta={meta} />
                <CaptureMetaPanel meta={meta} />
                <div className="text-[10px] opacity-40 mt-1.5 font-mono">{timeAgo(m.created_at)}</div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {/* Reply box */}
      <form onSubmit={handleSend} className="border-t border-border px-5 py-3 flex items-center gap-2 glass-surface">
        <input
          ref={inputRef}
          onKeyDown={handleKeyDown}
          placeholder="Reply to Shelly… (⌘+Enter)"
          className="flex-1 h-10 px-4 rounded-xl border border-border bg-background/50 text-sm input-glow transition-all placeholder:text-muted-foreground/30"
        />
        <button type="submit" disabled={sending}
          className="h-10 w-10 rounded-xl bg-brand text-brand-foreground flex items-center justify-center disabled:opacity-40 cursor-pointer hover:bg-brand/90 transition-colors shadow-lg shadow-brand/10">
          <IconSend width={16} height={16} />
        </button>
      </form>
    </div>
  );
}
