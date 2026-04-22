// src/dashboard/components/filter-bar.jsx
// Compact filter row: priority + type + needs-me. Project filtering happens
// via the topbar project switcher (single source of truth).
import { useEffect } from 'react';

const PRIORITY_CHIPS = [
  { id: 'now',   label: 'Now',   tone: 'error' },
  { id: 'today', label: 'Today', tone: 'warning' },
  { id: 'later', label: 'Later', tone: 'muted' },
];

const TYPE_CHIPS = [
  { id: 'blockers', label: 'Blockers' },
  { id: 'captures', label: 'Captures' },
  { id: 'deploys',  label: 'Deploys' },
  { id: 'ships',    label: 'Ships' },
];

const TONE_DOT = {
  error:   'bg-[var(--color-error)]',
  warning: 'bg-[var(--color-warning)]',
  muted:   'bg-[var(--color-foreground-faint)]',
};

function Chip({ active, tone, label, onClick }) {
  return (
    <button onClick={onClick} className={`filter-chip ${active ? 'active' : ''}`}>
      {tone && <span className={`w-1.5 h-1.5 rounded-full ${TONE_DOT[tone]}`} />}
      <span>{label}</span>
    </button>
  );
}

export function FilterBar({ filters, onChange }) {
  useEffect(() => {
    const params = new URLSearchParams();
    if (filters.priority) params.set('priority', filters.priority);
    if (filters.project) params.set('project', filters.project);
    if (filters.type) params.set('type', filters.type);
    if (filters.needs_me_only) params.set('needs_me', '1');
    const qs = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? '?' + qs : ''}`);
  }, [filters]);

  function toggle(key, value) {
    onChange(prev => ({ ...prev, [key]: prev[key] === value ? null : value }));
  }

  return (
    <div
      className="flex items-center gap-1 px-3 h-10 border-b border-[var(--color-border-subtle)] overflow-x-auto text-nowrap"
      style={{ background: 'var(--color-background)' }}
    >
      <Chip label="All" active={!filters.priority} onClick={() => onChange(f => ({ ...f, priority: null }))} />
      {PRIORITY_CHIPS.map(c => (
        <Chip key={c.id} label={c.label} tone={c.tone} active={filters.priority === c.id}
              onClick={() => toggle('priority', c.id)} />
      ))}

      <span className="w-px h-4 bg-[var(--color-border-subtle)] mx-2" />

      {TYPE_CHIPS.map(c => (
        <Chip key={c.id} label={c.label} active={filters.type === c.id}
              onClick={() => toggle('type', c.id)} />
      ))}

      <div className="flex-1 min-w-2" />

      <Chip
        label="Needs me"
        active={!!filters.needs_me_only}
        onClick={() => onChange(f => ({ ...f, needs_me_only: !f.needs_me_only }))}
      />
    </div>
  );
}
