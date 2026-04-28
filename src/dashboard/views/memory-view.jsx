// src/dashboard/views/memory-view.jsx
// Memory surface — brief, browse by kind, recent.
import { useState, useEffect, useCallback } from 'react';
import { MemoryBrief } from '@/components/memory-brief';
import { MemoryRow } from '@/components/memory-row';
import { MemoryWriteModal } from '@/components/memory-write-modal';
import { IconPlus } from '@/components/icons';

const TABS = [
  { id: 'brief',  label: 'Brief' },
  { id: 'browse', label: 'Browse' },
  { id: 'recent', label: 'Recent' },
];

const KINDS = [
  { value: '',               label: 'All' },
  { value: 'decision',       label: 'Decisions' },
  { value: 'retrospective',  label: 'Retros' },
  { value: 'spec_note',      label: 'Spec notes' },
  { value: 'debug_finding',  label: 'Debug findings' },
  { value: 'handoff',        label: 'Handoffs' },
];

function PageHeader({ title, right }) {
  return (
    <div className="flex items-center gap-3 px-6 h-14 border-b border-[var(--color-border-subtle)] shrink-0">
      <h1 className="text-[15px] font-semibold tracking-tight text-[var(--color-foreground)]">{title}</h1>
      <div className="flex-1" />
      {right}
    </div>
  );
}

export function MemoryView({ apiUrl }) {
  const [tab, setTab] = useState('brief');
  const [kind, setKind] = useState('');
  const [memories, setMemories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showWrite, setShowWrite] = useState(false);
  const [selected, setSelected] = useState(null);

  const fetchMemories = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (kind) params.set('kind', kind);
      params.set('limit', '50');
      const res = await fetch(`${apiUrl}/memories?${params}`);
      if (!res.ok) throw new Error(`${res.status}`);
      setMemories(await res.json());
    } catch (e) {
      console.error('Failed to fetch memories:', e);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, kind]);

  useEffect(() => {
    if (tab === 'browse' || tab === 'recent') fetchMemories();
  }, [tab, kind, fetchMemories]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Memory"
        right={
          <button
            onClick={() => setShowWrite(true)}
            className="flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
          >
            <IconPlus width={12} height={12} />
            Write
          </button>
        }
      />

      <div className="flex items-center gap-1 px-6 h-10 border-b border-[var(--color-border-subtle)] shrink-0">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1 rounded text-[12px] font-medium transition-colors ${
              tab === t.id
                ? 'bg-[var(--color-surface-2)] text-[var(--color-foreground)]'
                : 'text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)]'
            }`}
          >
            {t.label}
          </button>
        ))}

        {tab === 'browse' && (
          <div className="flex items-center gap-1 ml-4 pl-4 border-l border-[var(--color-border-subtle)]">
            {KINDS.map(k => (
              <button
                key={k.value}
                onClick={() => setKind(k.value)}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                  kind === k.value
                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                    : 'text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground-muted)]'
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'brief' && <MemoryBrief apiUrl={apiUrl} />}

        {(tab === 'browse' || tab === 'recent') && (
          <>
            {loading && (
              <div className="p-4 text-[13px] text-[var(--color-foreground-muted)]">Loading...</div>
            )}
            {!loading && memories.length === 0 && (
              <div className="p-4 text-[13px] text-[var(--color-foreground-faint)]">No memories found.</div>
            )}
            {!loading && memories.map(m => (
              <MemoryRow key={m.id} memory={m} onClick={setSelected} />
            ))}
          </>
        )}
      </div>

      {/* Detail panel */}
      {selected && (
        <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-4 max-h-[40%] overflow-y-auto shrink-0">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[14px] font-semibold text-[var(--color-foreground)]">{selected.title}</h3>
            <button
              onClick={() => setSelected(null)}
              className="text-[11px] text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground-muted)]"
            >
              close
            </button>
          </div>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-[var(--color-surface-2)] text-[var(--color-foreground-muted)]">
              {selected.kind}
            </span>
            <span className="text-[11px] text-[var(--color-foreground-faint)] font-mono">{selected.agent}</span>
            {selected.work_item_id && (
              <span className="text-[11px] text-[var(--color-foreground-faint)] font-mono">wi:{selected.work_item_id.slice(0, 8)}</span>
            )}
            {selected.tags?.length > 0 && selected.tags.map(t => (
              <span key={t} className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--color-surface-2)] text-[var(--color-foreground-faint)]">
                {t}
              </span>
            ))}
          </div>
          <p className="text-[13px] text-[var(--color-foreground)] leading-relaxed whitespace-pre-wrap">{selected.content}</p>
        </div>
      )}

      <MemoryWriteModal
        open={showWrite}
        onClose={() => setShowWrite(false)}
        apiUrl={apiUrl}
        onWritten={() => { if (tab !== 'brief') fetchMemories(); }}
      />
    </div>
  );
}
