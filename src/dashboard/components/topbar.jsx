// src/dashboard/components/topbar.jsx
import { useState, useRef, useEffect } from 'react';
import { listLocalProjects, getCurrentProject, setCurrentProject } from '@/lib/projects-store';
import { IconLogo, IconChevronDown, IconSearch, IconPlus } from './icons';

function ProjectAvatar({ name, tone = 'muted', size = 20 }) {
  const initials = (name || '?').slice(0, 2).toUpperCase();
  const cls = tone === 'brand'
    ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)]'
    : 'bg-[var(--color-surface-3)] text-[var(--color-foreground-muted)]';
  return (
    <span
      className={`rounded-md flex items-center justify-center font-mono shrink-0 ${cls}`}
      style={{ width: size, height: size, fontSize: size <= 18 ? 8 : 9, fontWeight: 700 }}
    >
      {initials}
    </span>
  );
}

function ProjectPicker({ current, onSwitch, onManage, onAdd }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const projects = listLocalProjects();

  useEffect(() => {
    function onDocClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function pick(id) {
    setCurrentProject(id);
    setOpen(false);
    onSwitch?.(id);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 h-7 px-2 rounded-md text-[13px] text-[var(--color-foreground)] hover:bg-[var(--color-surface-2)] cursor-pointer transition-colors"
        title="Switch project"
      >
        <ProjectAvatar name={current?.name} tone="brand" size={18} />
        <span className="font-medium truncate max-w-[160px]">{current?.name || 'No project'}</span>
        <IconChevronDown width={12} height={12} className="opacity-50" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-[280px] rounded-lg surface-elevated shadow-2xl z-50 animate-scale-in overflow-hidden">
          <div className="p-1">
            {projects.length === 0 && (
              <div className="px-3 py-2 text-[12px] text-[var(--color-foreground-faint)]">No projects yet</div>
            )}
            {projects.map(p => (
              <button
                key={p.id}
                onClick={() => pick(p.id)}
                className={`w-full text-left px-2 py-1.5 rounded-md text-[13px] cursor-pointer flex items-center gap-2 transition-colors ${
                  p.id === current?.id
                    ? 'bg-[var(--color-surface-3)] text-[var(--color-foreground)]'
                    : 'text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-foreground)]'
                }`}
              >
                <ProjectAvatar name={p.name} tone={p.id === current?.id ? 'brand' : 'muted'} size={18} />
                <span className="truncate">{p.name}</span>
                {p.github_repo && (
                  <span className="text-[10.5px] text-[var(--color-foreground-faint)] font-mono truncate ml-auto">
                    {p.github_repo}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="border-t border-[var(--color-border-subtle)] p-1">
            <button
              onClick={() => { setOpen(false); onAdd?.(); }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-foreground)] cursor-pointer transition-colors"
            >
              <IconPlus width={14} height={14} />
              <span>Add project</span>
            </button>
            <button
              onClick={() => { setOpen(false); onManage?.(); }}
              className="w-full text-left px-2 py-1.5 rounded-md text-[13px] text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-foreground)] cursor-pointer transition-colors"
            >
              Manage projects…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Topbar({ currentProject, onProjectSwitch, onManageProjects, onAddProject, onOpenPalette }) {
  return (
    <div className="topbar">
      <div className="flex items-center gap-2 pr-2">
        <IconLogo width={20} height={20} />
        <span className="text-[13px] font-semibold tracking-tight text-[var(--color-foreground)]">DevPanel</span>
      </div>

      <div className="h-4 w-px bg-[var(--color-border-subtle)]" />

      <ProjectPicker
        current={currentProject}
        onSwitch={onProjectSwitch}
        onManage={onManageProjects}
        onAdd={onAddProject}
      />

      <div className="flex-1" />

      <button
        onClick={onOpenPalette}
        className="flex items-center gap-2 h-7 px-2.5 rounded-md text-[12.5px] text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] bg-[var(--color-surface-1)] hover:bg-[var(--color-surface-2)] border border-[var(--color-border)] cursor-pointer transition-colors min-w-[240px]"
        title="Open command palette"
      >
        <IconSearch width={13} height={13} />
        <span>Search or run command…</span>
        <span className="flex-1" />
        <span className="kbd">⌘K</span>
      </button>
    </div>
  );
}
