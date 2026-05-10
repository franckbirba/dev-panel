// src/dashboard/components/capture-composer.jsx
// Floating modal composer for new captures. Reachable from anywhere via the
// "c" shortcut or the Inbox header button. Replaces the captures-view hero
// input — capture is a verb, not a tab.
import { useState, useEffect, useRef } from 'react';
import { IconClose, IconCapture } from './icons';

export function CaptureComposer({ open, apiUrl, apiKey, onClose, onCreated }) {
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const taRef = useRef(null);

  useEffect(() => {
    if (open) {
      setContent('');
      setError(null);
      setTimeout(() => taRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, content]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    const text = content.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${apiUrl}/api/captures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ content: text, kind: 'idea' }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const created = await r.json();
      onCreated?.(created);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[110] flex items-start justify-center pt-[18vh] modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="rounded-md w-[560px] max-w-[92vw] shadow-2xl"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
      >
        <div className="flex items-center gap-2 px-3 h-10 border-b border-[var(--color-border-subtle)]">
          <IconCapture width={14} height={14} className="text-[var(--color-foreground-faint)]" />
          <span className="text-[12px] text-[var(--color-foreground-muted)]">New capture</span>
          <div className="flex-1" />
          <span className="text-[10px] text-[var(--color-foreground-faint)]">⌘↵ to send · Esc to cancel</span>
          <button onClick={onClose} disabled={busy} className="cursor-pointer text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)] disabled:opacity-50">
            <IconClose width={14} height={14} />
          </button>
        </div>
        <textarea
          ref={taRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Quoi qu'il te passe par la tête… Shelly s'occupera de la suite."
          rows={6}
          className="w-full p-3 text-[13px] bg-transparent outline-none resize-none"
          style={{ color: 'var(--color-foreground)' }}
          disabled={busy}
        />
        {error && <div className="px-3 pb-2 text-[11px] text-[var(--color-error)]">Error: {error}</div>}
        <div className="flex items-center gap-2 px-3 h-11 border-t border-[var(--color-border-subtle)]">
          <span className="text-[10px] text-[var(--color-foreground-faint)]">{content.length} chars</span>
          <div className="flex-1" />
          <button onClick={onClose} disabled={busy} className="px-3 h-7 rounded text-[11px] cursor-pointer text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)]">Cancel</button>
          <button
            onClick={submit}
            disabled={busy || !content.trim()}
            className="px-4 h-7 rounded text-[11px] font-semibold cursor-pointer disabled:opacity-50 uppercase tracking-wider"
            style={{ background: 'var(--color-brand)', color: 'var(--color-brand-foreground)', letterSpacing: '0.08em' }}
          >
            {busy ? 'Sending…' : 'Capture ⌘↵'}
          </button>
        </div>
      </div>
    </div>
  );
}
