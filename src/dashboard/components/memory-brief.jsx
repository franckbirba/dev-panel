// src/dashboard/components/memory-brief.jsx
import { useState, useCallback } from 'react';
import { IconSearch } from './icons';

export function MemoryBrief({ apiUrl }) {
  const [query, setQuery] = useState('');
  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/memories/brief?q=${encodeURIComponent(query.trim())}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setBrief(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, query]);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && search()}
            placeholder="Brief on... (e.g. DEVPA-93, auth middleware, pagination)"
            className="w-full h-9 px-3 pl-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] text-[13px] text-[var(--color-foreground)] placeholder:text-[var(--color-foreground-faint)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
          />
          <IconSearch
            width={14} height={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-foreground-faint)]"
          />
        </div>
        <button
          onClick={search}
          disabled={loading || !query.trim()}
          className="h-9 px-4 rounded-md text-[13px] font-medium bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {loading ? 'Thinking...' : 'Brief'}
        </button>
      </div>

      {error && (
        <div className="text-[13px] text-[var(--color-error)] bg-[var(--color-error-soft)] rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {brief && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[12px] font-medium uppercase tracking-wider text-[var(--color-foreground-muted)]">
              Brief
            </span>
            {brief.cached && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-foreground-faint)]">
                cached
              </span>
            )}
            {brief.note && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-warning-soft)] text-[var(--color-warning)]">
                {brief.note}
              </span>
            )}
          </div>
          <p className="text-[13px] text-[var(--color-foreground)] leading-relaxed whitespace-pre-wrap">
            {brief.brief}
          </p>
        </div>
      )}
    </div>
  );
}
