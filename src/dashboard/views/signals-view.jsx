// src/dashboard/views/signals-view.jsx
import { useState, useEffect, useCallback } from 'react';
import { useSignals } from '@/lib/use-signals';
import { SignalRow } from '@/components/signal-row';
import { FilterBar } from '@/components/filter-bar';
import { ThreadPanel } from '@/components/thread-panel';
import { PasteUrlModal } from '@/components/paste-url-modal';
import { getAdminKey, listLocalProjects } from '@/lib/projects-store';

function BandHeader({ title, count, color, defaultOpen, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="sticky top-0 z-10 w-full flex items-center gap-2 px-4 py-2 bg-surface border-b border-border cursor-pointer"
      >
        <span className={`w-2 h-2 rounded-full ${color}`} />
        <span className="text-[11px] uppercase tracking-wider font-medium">{title}</span>
        <span className="text-[10px] text-muted-foreground tabular-nums">{count}</span>
        <span className="text-[10px] text-muted-foreground ml-auto">{open ? '\u25BC' : '\u25B8'}</span>
      </button>
      {open && <div className="divide-y divide-border/50">{children}</div>}
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
            <div className="flex items-center justify-center py-12">
              <span className="text-muted-foreground text-xs animate-pulse">Loading signals...</span>
            </div>
          )}

          {isEmpty && !loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              {hasProjects ? (
                <>
                  <span className="text-muted-foreground text-sm">Nothing on you. Agents are working.</span>
                  <span className="text-muted-foreground/50 text-xs">
                    {grouped.in_flight.length} in flight
                  </span>
                </>
              ) : (
                <>
                  <span className="text-muted-foreground text-sm">No projects yet.</span>
                  <button onClick={() => setShowPasteUrl(true)}
                    className="px-4 py-2 rounded-lg bg-foreground text-background text-sm font-medium hover:bg-foreground/90 cursor-pointer">
                    Add a project
                  </button>
                </>
              )}
            </div>
          )}

          {!loading && !isEmpty && (
            <>
              <BandHeader title="Needs you" count={grouped.needs_attention.length} color="bg-error" defaultOpen={true}>
                {grouped.needs_attention.length === 0 ? (
                  <div className="px-4 py-4 text-xs text-muted-foreground text-center">
                    Nothing waiting on you. Agents are working.
                  </div>
                ) : grouped.needs_attention.map(s => (
                  <SignalRow key={`${s.subject_type}-${s.subject_id}`} signal={s}
                    onSelect={handleSelect} onPrioritySet={handlePrioritySet}
                    isSelected={selected?.subject_type === s.subject_type && selected?.subject_id === s.subject_id} />
                ))}
              </BandHeader>

              <BandHeader title="In flight" count={grouped.in_flight.length} color="bg-info" defaultOpen={false}>
                {grouped.in_flight.map(s => (
                  <SignalRow key={`${s.subject_type}-${s.subject_id}`} signal={s}
                    onSelect={handleSelect} onPrioritySet={handlePrioritySet}
                    isSelected={selected?.subject_type === s.subject_type && selected?.subject_id === s.subject_id} />
                ))}
              </BandHeader>

              <BandHeader title="Shipped / FYI" count={grouped.fyi.length} color="bg-success" defaultOpen={false}>
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
