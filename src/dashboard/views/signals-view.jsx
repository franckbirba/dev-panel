// src/dashboard/views/signals-view.jsx
import { useState, useEffect, useCallback } from 'react';
import { useSignals } from '@/lib/use-signals';
import { SignalRow } from '@/components/signal-row';
import { FilterBar } from '@/components/filter-bar';
import { ThreadPanel } from '@/components/thread-panel';
import { PasteUrlModal } from '@/components/paste-url-modal';
import { getAdminKey, listLocalProjects } from '@/lib/projects-store';
import { IconChevronDown, IconChevronRight, IconPlus } from '@/components/icons';

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="skeleton w-8 h-8 rounded-lg shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="skeleton h-2.5 w-32 rounded" />
        <div className="skeleton h-3 w-48 rounded" />
      </div>
      <div className="skeleton h-3 w-8 rounded" />
    </div>
  );
}

const BAND_DOT = {
  error:   'var(--color-error)',
  info:    'var(--color-info)',
  success: 'var(--color-success)',
  brand:   'var(--color-brand)',
};

function BandHeader({ title, count, tone, defaultOpen, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="animate-fade-in-up">
      <button onClick={() => setOpen(o => !o)} className="band-header w-full">
        <span className="band-dot" style={{ background: BAND_DOT[tone] || BAND_DOT.brand }} />
        <span>{title}</span>
        <span className="band-count">{count}</span>
        <span className="ml-auto opacity-50">
          {open ? <IconChevronDown width={12} height={12} /> : <IconChevronRight width={12} height={12} />}
        </span>
      </button>
      {open && (
        <div className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

function parseUrlFilters() {
  const params = new URLSearchParams(window.location.search);
  return {
    priority: params.get('priority') || null,
    project: params.get('project') || null,
    type: params.get('type') || null,
    needs_me_only: params.get('needs_me') === '1',
  };
}

export function SignalsView({ apiUrl, apiKey }) {
  const [filters, setFilters] = useState(parseUrlFilters);
  const [selected, setSelected] = useState(null);
  const [showPasteUrl, setShowPasteUrl] = useState(false);
  const { grouped, loading, error, refetch } = useSignals({ apiUrl, apiKey, filters });

  // Parse thread from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const thread = params.get('thread');
    if (thread) {
      const [type, id] = thread.split('/');
      if (type && id) setSelected({ subject_type: type, subject_id: id });
    }
  }, []);

  // Update URL when thread changes
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (selected) {
      params.set('thread', `${selected.subject_type}/${selected.subject_id}`);
    } else {
      params.delete('thread');
    }
    const qs = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? '?' + qs : ''}`);
  }, [selected]);

  const handlePrioritySet = useCallback(async (type, id, priority) => {
    const adminKey = getAdminKey();
    await fetch(`${apiUrl}/api/subjects/${type}/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        ...(adminKey ? { 'X-Admin-Key': adminKey } : {}),
      },
      body: JSON.stringify({ priority })
    });
  }, [apiUrl, apiKey]);

  function handleSelect(signal) {
    setSelected({
      subject_type: signal.subject_type,
      subject_id: signal.subject_id,
      title: signal.title,
      project_name: signal.project_name,
    });
  }

  // Close on Escape
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') setSelected(null); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hasProjects = listLocalProjects().length > 0;
  const isEmpty = !loading && grouped.needs_attention.length === 0
    && grouped.in_flight.length === 0 && grouped.fyi.length === 0;

  return (
    <div className="h-full flex">
      <div className="flex-1 flex flex-col overflow-hidden">
        <FilterBar filters={filters} onChange={setFilters} />

        {error && (
          <div className="px-4 py-2 text-[11px] text-error bg-error/5 border-b border-error/20 font-mono">{error}</div>
        )}

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="divide-y divide-border/30">
              {Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)}
            </div>
          )}

          {isEmpty && !loading && (
            <div className="flex flex-col items-center justify-center py-20 gap-5 empty-state h-full">
              {hasProjects ? (
                <>
                  <div className="w-16 h-16 rounded-2xl bg-success/10 flex items-center justify-center">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-success">
                      <circle cx="12" cy="12" r="10" /><path d="M9 12l2 2 4-4" />
                    </svg>
                  </div>
                  <div className="text-center">
                    <p className="text-foreground/80 text-sm font-medium">All clear</p>
                    <p className="text-muted-foreground/50 text-xs mt-1">Nothing on you. Agents are working.</p>
                  </div>
                </>
              ) : (
                <>
                  <div className="w-16 h-16 rounded-2xl bg-brand/10 flex items-center justify-center">
                    <IconPlus width={28} height={28} className="text-brand" />
                  </div>
                  <div className="text-center">
                    <p className="text-foreground/80 text-sm font-medium">No projects yet</p>
                    <p className="text-muted-foreground/50 text-xs mt-1">Add a project to start seeing signals</p>
                  </div>
                  <button onClick={() => setShowPasteUrl(true)}
                    className="px-5 py-2.5 rounded-xl bg-brand text-brand-foreground text-sm font-medium hover:bg-brand/90 cursor-pointer shadow-lg shadow-brand/15 transition-all">
                    Add a project
                  </button>
                </>
              )}
            </div>
          )}

          {!loading && !isEmpty && (
            <>
              <BandHeader title="Needs you" count={grouped.needs_attention.length} tone="error" defaultOpen={true}>
                {grouped.needs_attention.length === 0 ? (
                  <div className="px-4 py-6 text-xs text-muted-foreground/50 text-center">
                    Nothing waiting on you. Agents are working.
                  </div>
                ) : grouped.needs_attention.map(s => (
                  <SignalRow key={`${s.subject_type}-${s.subject_id}`} signal={s}
                    onSelect={handleSelect} onPrioritySet={handlePrioritySet}
                    isSelected={selected?.subject_type === s.subject_type && selected?.subject_id === s.subject_id} />
                ))}
              </BandHeader>

              <BandHeader title="In flight" count={grouped.in_flight.length} tone="info" defaultOpen={false}>
                {grouped.in_flight.map(s => (
                  <SignalRow key={`${s.subject_type}-${s.subject_id}`} signal={s}
                    onSelect={handleSelect} onPrioritySet={handlePrioritySet}
                    isSelected={selected?.subject_type === s.subject_type && selected?.subject_id === s.subject_id} />
                ))}
              </BandHeader>

              <BandHeader title="Shipped / FYI" count={grouped.fyi.length} tone="success" defaultOpen={false}>
                {grouped.fyi.map(s => (
                  <SignalRow key={`${s.subject_type}-${s.subject_id}`} signal={s}
                    onSelect={handleSelect} onPrioritySet={handlePrioritySet}
                    isSelected={selected?.subject_type === s.subject_type && selected?.subject_id === s.subject_id} />
                ))}
              </BandHeader>
            </>
          )}
        </div>
      </div>

      {selected && (
        <ThreadPanel
          subject={selected}
          apiUrl={apiUrl}
          apiKey={apiKey}
          onClose={() => setSelected(null)}
        />
      )}

      {showPasteUrl && (
        <PasteUrlModal
          apiUrl={apiUrl}
          onClose={() => setShowPasteUrl(false)}
          onCreated={() => { setShowPasteUrl(false); refetch(); }}
        />
      )}
    </div>
  );
}
