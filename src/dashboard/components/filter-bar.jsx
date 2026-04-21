// src/dashboard/components/filter-bar.jsx
import { useEffect, useState } from 'react';
import { listLocalProjects } from '@/lib/projects-store';

const PRIORITY_CHIPS = [
  { id: 'now', label: 'now', color: 'bg-error' },
  { id: 'today', label: 'today', color: 'bg-warning' },
  { id: 'later', label: 'later', color: 'bg-muted-foreground' },
];

const TYPE_CHIPS = [
  { id: 'blockers', label: 'blockers' },
  { id: 'captures', label: 'captures' },
  { id: 'deploys', label: 'deploys' },
  { id: 'ships', label: 'ships' },
];

function Chip({ active, color, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-md cursor-pointer transition-colors ${
        active
          ? 'bg-secondary text-foreground font-medium'
          : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
      }`}
    >
      {color && <span className={`w-1.5 h-1.5 rounded-full ${color}`} />}
      {label}
    </button>
  );
}

export function FilterBar({ filters, onChange }) {
  const [projects] = useState(() => listLocalProjects());

  // Sync filters to URL
  useEffect(() => {
    const params = new URLSearchParams();
    if (filters.priority) params.set('priority', filters.priority);
    if (filters.project) params.set('project', filters.project);
    if (filters.type) params.set('type', filters.type);
    if (filters.needs_me_only) params.set('needs_me', '1');
    const qs = params.toString();
    const newUrl = `${window.location.pathname}${qs ? '?' + qs : ''}`;
    window.history.replaceState(null, '', newUrl);
  }, [filters]);

  function toggle(key, value) {
    onChange(prev => ({
      ...prev,
      [key]: prev[key] === value ? null : value,
    }));
  }

  return (
    <div className="flex items-center gap-1 px-4 py-2 border-b border-border bg-surface overflow-x-auto text-nowrap">
      <Chip label="all" active={!filters.priority} onClick={() => onChange(f => ({ ...f, priority: null }))} />
      {PRIORITY_CHIPS.map(c => (
        <Chip key={c.id} label={c.label} color={c.color} active={filters.priority === c.id}
          onClick={() => toggle('priority', c.id)} />
      ))}

      <span className="w-px h-4 bg-border mx-1" />

      <Chip label="all projects" active={!filters.project}
        onClick={() => onChange(f => ({ ...f, project: null }))} />
      {projects.map(p => (
        <Chip key={p.id} label={p.name} active={filters.project === p.id}
          onClick={() => toggle('project', p.id)} />
      ))}

      <span className="w-px h-4 bg-border mx-1" />

      {TYPE_CHIPS.map(c => (
        <Chip key={c.id} label={c.label} active={filters.type === c.id}
          onClick={() => toggle('type', c.id)} />
      ))}

      <span className="w-px h-4 bg-border mx-1" />

      <Chip
        label="needs me only"
        active={!!filters.needs_me_only}
        onClick={() => onChange(f => ({ ...f, needs_me_only: !f.needs_me_only }))}
      />
    </div>
  );
}
