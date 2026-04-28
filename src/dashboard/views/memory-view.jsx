// src/dashboard/views/memory-view.jsx
// Memory surface — exposes the studio's pgvector memories to the human.
// Three reads: brief on X (search), browse by kind, recent.
// One write: modal composer (kind/title/content/tags).
import { useState, useEffect, useCallback, useMemo } from 'react';
import { IconBrain, IconRefresh, IconPlus, IconSearch, IconClose } from '@/components/icons';

const KINDS = [
  'decision',
  'retrospective',
  'spec_note',
  'debug_finding',
  'handoff',
  'audit_finding',
];

const KIND_TONE = {
  decision:        { fg: 'var(--color-info)',    bg: 'var(--color-info-soft)'    },
  retrospective:   { fg: 'var(--color-success)', bg: 'var(--color-success-soft)' },
  spec_note:       { fg: 'var(--color-foreground-muted)', bg: 'var(--color-surface-2)' },
  debug_finding:   { fg: 'var(--color-warning)', bg: 'var(--color-warning-soft)' },
  handoff:         { fg: 'var(--color-info)',    bg: 'var(--color-info-soft)'    },
  audit_finding:   { fg: 'var(--color-error)',   bg: 'var(--color-error-soft)'   },
};

function timeAgo(iso) {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function MemoryCard({ memory, expanded, onToggle }) {
  const tone = KIND_TONE[memory.kind] || KIND_TONE.spec_note;
  return (
    <div
      onClick={onToggle}
      className="border-b border-[var(--color-border-subtle)] px-4 py-3 cursor-pointer hover:bg-[var(--color-surface-2)] transition-colors"
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="px-1.5 py-0.5 rounded-sm text-[9px] uppercase tracking-wider font-mono"
          style={{ color: tone.fg, background: tone.bg }}>
          {memory.kind}
        </span>
        {memory.work_item_id && (
          <span className="text-[10px] font-mono text-[var(--color-foreground-faint)]">{memory.work_item_id}</span>
        )}
        {memory.module_id && (
          <span className="text-[10px] text-[var(--color-foreground-faint)]">module:{memory.module_id}</span>
        )}
        {memory.agent && (
          <span className="text-[10px] text-[var(--color-foreground-faint)]">by {memory.agent}</span>
        )}
        <div className="flex-1" />
        <span className="text-[10px] text-[var(--color-foreground-faint)]">{timeAgo(memory.created_at)}</span>
      </div>
      <div className="text-[13px] text-[var(--color-foreground)]">{memory.title}</div>
      <div className={`text-[12px] text-[var(--color-foreground-muted)] mt-1 ${expanded ? '' : 'line-clamp-2'}`}>
        {memory.content}
      </div>
      {memory.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {memory.tags.map(t => (
            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-foreground-faint)]">
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function WriteModal({ open, apiUrl, apiKey, onClose, onCreated }) {
  const [kind, setKind] = useState('decision');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [workItemId, setWorkItemId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setTitle(''); setContent(''); setTags(''); setWorkItemId('');
      setKind('decision'); setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape' && !busy) onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, kind, title, content, tags, workItemId]); // eslint-disable-line

  async function submit() {
    if (!title.trim() || !content.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${apiUrl}/api/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({
          kind,
          title: title.trim(),
          content: content.trim(),
          tags: tags.split(',').map(t => t.trim()).filter(Boolean),
          work_item_id: workItemId.trim() || null,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onCreated?.(await r.json());
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[110] flex items-start justify-center pt-[12vh] modal-backdrop" onClick={() => !busy && onClose()}>
      <div onClick={e => e.stopPropagation()} className="w-[600px] max-w-[92vw] rounded-md shadow-2xl"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <div className="flex items-center gap-2 px-3 h-10 border-b border-[var(--color-border-subtle)]">
          <IconBrain width={14} height={14} className="text-[var(--color-foreground-faint)]" />
          <span className="text-[12px] text-[var(--color-foreground-muted)]">Write memory</span>
          <div className="flex-1" />
          <span className="text-[10px] text-[var(--color-foreground-faint)]">⌘↵ to save · Esc to cancel</span>
          <button onClick={onClose} disabled={busy} className="cursor-pointer text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)]">
            <IconClose width={14} height={14} />
          </button>
        </div>
        <div className="p-3 space-y-2">
          <div className="flex gap-2">
            <select value={kind} onChange={e => setKind(e.target.value)} className="px-2 h-8 text-[12px] rounded outline-none"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}>
              {KINDS.map(k => <option key={k} value={k}>{k}</option>)}
            </select>
            <input value={workItemId} onChange={e => setWorkItemId(e.target.value)} placeholder="work_item_id (optional, e.g. DEVPA-93)"
              className="flex-1 px-2 h-8 text-[12px] rounded outline-none"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }} />
          </div>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title (one line)"
            className="w-full px-2 h-8 text-[13px] rounded outline-none"
            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }} />
          <textarea value={content} onChange={e => setContent(e.target.value)} placeholder="What's the decision / finding / retro?"
            rows={6}
            className="w-full px-2 py-2 text-[12px] rounded outline-none resize-none"
            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-foreground)' }} />
          <input value={tags} onChange={e => setTags(e.target.value)} placeholder="Tags, comma-separated (optional)"
            className="w-full px-2 h-8 text-[11px] rounded outline-none"
            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }} />
          {error && <div className="text-[11px] text-[var(--color-error)]">Error: {error}</div>}
        </div>
        <div className="flex items-center gap-2 px-3 h-11 border-t border-[var(--color-border-subtle)]">
          <div className="flex-1" />
          <button onClick={onClose} disabled={busy} className="px-3 h-7 rounded text-[11px] cursor-pointer text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)]">Cancel</button>
          <button onClick={submit} disabled={busy || !title.trim() || !content.trim()}
            className="px-4 h-7 rounded text-[11px] font-medium cursor-pointer disabled:opacity-50"
            style={{ background: 'var(--color-foreground)', color: 'var(--color-background)' }}>
            {busy ? 'Saving…' : 'Save (⌘↵)'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function MemoryView({ apiUrl, apiKey }) {
  const [memories, setMemories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [degraded, setDegraded] = useState(false);
  // Read initial q from URL — Cmd-K's "Find memory about…" navigates here with ?q=
  const initialParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const [q, setQ] = useState(initialParams?.get('q') || '');
  const [kindFilter, setKindFilter] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [writeOpen, setWriteOpen] = useState(initialParams?.get('write') === '1');

  const load = useCallback(async () => {
    if (!apiKey) return;
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (kindFilter) params.set('kind', kindFilter);
      params.set('limit', '100');
      const r = await fetch(`${apiUrl}/api/memories?${params}`, { headers: { 'X-API-Key': apiKey } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setMemories(d.memories || []);
      setDegraded(!!d.degraded);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, apiKey, q, kindFilter]);

  useEffect(() => { load(); }, [load]);

  // Debounced search — re-load 300ms after the user stops typing.
  useEffect(() => {
    const id = setTimeout(load, 300);
    return () => clearTimeout(id);
  }, [q, kindFilter]); // eslint-disable-line

  // Group counts (from current result set, not total — good enough)
  const counts = useMemo(() => {
    const c = { total: memories.length };
    for (const k of KINDS) c[k] = memories.filter(m => m.kind === k).length;
    return c;
  }, [memories]);

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center gap-3 h-12 px-4 border-b border-[var(--color-border-subtle)] shrink-0">
          <h1 className="text-[14px] font-semibold tracking-tight">Memory</h1>
          <span className="text-[11px] text-[var(--color-foreground-faint)]">
            {counts.total} {counts.total === 1 ? 'memory' : 'memories'}
            {degraded && ' (degraded — postgres unreachable)'}
          </span>
          <div className="flex-1" />
          <div className="relative">
            <IconSearch width={12} height={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-foreground-faint)]" />
            <input
              value={q} onChange={e => setQ(e.target.value)}
              placeholder="Search… (work_item, tag, title)"
              className="pl-7 pr-2 h-7 text-[12px] rounded outline-none w-64"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
            />
          </div>
          <button onClick={() => setWriteOpen(true)}
            className="h-7 px-2 rounded text-[11px] cursor-pointer flex items-center gap-1"
            style={{ background: 'var(--color-foreground)', color: 'var(--color-background)' }}>
            <IconPlus width={12} height={12} /> write
          </button>
          <button onClick={load} className="h-7 w-7 rounded cursor-pointer text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)]" title="refresh">
            <IconRefresh width={12} height={12} className="mx-auto" />
          </button>
        </div>

        {/* Kind filter strip */}
        <div className="flex items-center gap-1 px-4 h-9 border-b border-[var(--color-border-subtle)] shrink-0 overflow-x-auto">
          <button onClick={() => setKindFilter(null)}
            className={`h-6 px-2 rounded text-[10.5px] uppercase tracking-wider font-medium cursor-pointer transition-colors ${kindFilter === null ? 'bg-[var(--color-surface-2)] text-[var(--color-foreground)]' : 'text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)]'}`}>
            all {counts.total}
          </button>
          {KINDS.map(k => (
            <button key={k} onClick={() => setKindFilter(k)}
              className={`h-6 px-2 rounded text-[10.5px] uppercase tracking-wider font-medium cursor-pointer transition-colors ${kindFilter === k ? 'bg-[var(--color-surface-2)] text-[var(--color-foreground)]' : 'text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)]'}`}
              style={kindFilter === k ? { color: KIND_TONE[k].fg } : undefined}>
              {k.replace('_', ' ')} {counts[k]}
            </button>
          ))}
        </div>

        {/* List */}
        <div className="flex-1 overflow-auto">
          {error && <div className="px-4 py-3 text-[12px] text-[var(--color-error)]">Error: {error}</div>}
          {loading && memories.length === 0 && (
            <div className="px-6 py-16 text-center text-[12px] text-[var(--color-foreground-faint)]">Loading memories…</div>
          )}
          {!loading && memories.length === 0 && !error && (
            <div className="px-6 py-16 text-center">
              <IconBrain width={32} height={32} className="mx-auto mb-3 text-[var(--color-foreground-faint)]" />
              <div className="text-[12px] text-[var(--color-foreground-faint)] mb-1">
                {q ? 'No memories match.' : 'No memories yet.'}
              </div>
              <div className="text-[11px] text-[var(--color-foreground-faint)]">
                Press <span className="kbd">+</span> Write to drop the first one.
              </div>
            </div>
          )}
          {memories.map(m => (
            <MemoryCard
              key={m.id}
              memory={m}
              expanded={expandedId === m.id}
              onToggle={() => setExpandedId(expandedId === m.id ? null : m.id)}
            />
          ))}
        </div>
      </div>

      <WriteModal
        open={writeOpen}
        apiUrl={apiUrl} apiKey={apiKey}
        onClose={() => setWriteOpen(false)}
        onCreated={() => { setWriteOpen(false); load(); }}
      />
    </div>
  );
}
