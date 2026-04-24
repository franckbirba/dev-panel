// src/dashboard/components/command-palette.jsx
// ⌘K palette: navigate, switch project, add project, common actions.
import { useState, useEffect, useMemo, useRef } from 'react';
import { listLocalProjects, setCurrentProject } from '@/lib/projects-store';
import {
  IconSignals, IconToday, IconInbox, IconQueues, IconOps, IconAgents, IconChain,
  IconShelly, IconProjects, IconSettings, IconPlus, IconSearch
} from './icons';

const NAV = [
  { id: 'captures',   label: 'Inbox',      icon: IconInbox,     hint: 'Operations' },
  { id: 'today',      label: 'Today',      icon: IconToday,     hint: 'Operations' },
  { id: 'signals',    label: 'Signals',    icon: IconSignals,   hint: 'Operations' },
  { id: 'agents',     label: 'Agents',     icon: IconAgents,    hint: 'Infrastructure' },
  { id: 'work-items', label: 'Work items', icon: IconChain,     hint: 'Infrastructure' },
  { id: 'queues',     label: 'Queues',     icon: IconQueues,    hint: 'Infrastructure' },
  { id: 'shelly',     label: 'Shelly',     icon: IconShelly,    hint: 'Infrastructure' },
  { id: 'ops',        label: 'Ops',        icon: IconOps,       hint: 'Infrastructure' },
  { id: 'projects',   label: 'Projects',   icon: IconProjects,  hint: 'Manage' },
  { id: 'settings',   label: 'Settings',   icon: IconSettings,  hint: 'Manage' },
];

function fuzzyMatch(query, text) {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  let i = 0;
  for (const ch of t) { if (ch === q[i]) i++; if (i === q.length) return true; }
  return false;
}

export function CommandPalette({ open, onClose, onNavigate, onProjectSwitch, onAddProject }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const projects = useMemo(() => listLocalProjects(), [open]);

  const items = useMemo(() => {
    const list = [];
    NAV.forEach(n => {
      if (fuzzyMatch(q, n.label)) list.push({
        kind: 'nav', id: n.id, label: `Go to ${n.label}`, hint: n.hint, icon: n.icon,
        onPick: () => onNavigate(n.id),
      });
    });
    projects.forEach(p => {
      if (fuzzyMatch(q, p.name)) list.push({
        kind: 'project', id: p.id, label: `Switch to ${p.name}`,
        hint: p.github_repo || 'Project', icon: null,
        onPick: () => { setCurrentProject(p.id); onProjectSwitch?.(p.id); },
      });
    });
    if (fuzzyMatch(q, 'add project') || fuzzyMatch(q, 'new project')) {
      list.push({
        kind: 'action', id: 'add-project', label: 'Add a new project',
        hint: 'Action', icon: IconPlus,
        onPick: () => onAddProject?.(),
      });
    }
    return list;
  }, [q, projects, onNavigate, onProjectSwitch, onAddProject]);

  useEffect(() => { if (idx >= items.length) setIdx(0); }, [items, idx]);

  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, items.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = items[idx];
        if (item) { item.onPick(); onClose(); }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, items, idx, onClose]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${idx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] modal-backdrop animate-fade-in-up" onClick={onClose}>
      <div className="cmdk animate-scale-in" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3" style={{ borderBottom: '1px solid var(--color-border)' }}>
          <IconSearch width={14} height={14} className="text-[var(--color-foreground-faint)]" />
          <input
            ref={inputRef}
            value={q}
            onChange={e => { setQ(e.target.value); setIdx(0); }}
            placeholder="Search or run command…"
            className="cmdk-input"
            style={{ borderBottom: 0, padding: '0 4px' }}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {items.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-[var(--color-foreground-faint)]">
              No matches
            </div>
          )}
          {items.map((it, i) => {
            const Icon = it.icon;
            return (
              <div
                key={`${it.kind}-${it.id}`}
                data-idx={i}
                onClick={() => { it.onPick(); onClose(); }}
                onMouseEnter={() => setIdx(i)}
                className={`cmdk-item ${i === idx ? 'selected' : ''}`}
              >
                {Icon ? <Icon width={14} height={14} /> : <span className="w-3.5 h-3.5" />}
                <span className="flex-1">{it.label}</span>
                <span className="text-[11px] text-[var(--color-foreground-faint)]">{it.hint}</span>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2 px-3 py-2 border-t border-[var(--color-border)] text-[10.5px] text-[var(--color-foreground-faint)]">
          <span className="kbd">↑</span><span className="kbd">↓</span> navigate
          <span className="kbd ml-2">↵</span> select
          <span className="flex-1" />
          <span className="kbd">⌘K</span> toggle
        </div>
      </div>
    </div>
  );
}
