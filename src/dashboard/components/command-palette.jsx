// src/dashboard/components/command-palette.jsx
// Cmd-K palette: navigate, switch project, add project, and action commands.
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { listLocalProjects, setCurrentProject, getAdminKey } from '@/lib/projects-store';
import { commands, executeCommand } from '@/lib/commands';
import { IconSearch } from './icons';

function fuzzyMatch(query, text) {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  let i = 0;
  for (const ch of t) { if (ch === q[i]) i++; if (i === q.length) return true; }
  return false;
}

export function CommandPalette({ open, onClose, onNavigate, onProjectSwitch, onAddProject, apiKey }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState('search'); // 'search' | 'params' | 'result'
  const [activeCmd, setActiveCmd] = useState(null);
  const [paramValues, setParamValues] = useState({});
  const [focusedParam, setFocusedParam] = useState(0);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const paramRefs = useRef([]);

  const adminKey = useMemo(() => getAdminKey(), [open]);
  const isAdmin = !!adminKey;

  const resetToSearch = useCallback(() => {
    setMode('search');
    setActiveCmd(null);
    setParamValues({});
    setFocusedParam(0);
    setResult(null);
    setLoading(false);
    setTimeout(() => inputRef.current?.focus(), 10);
  }, []);

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      resetToSearch();
    }
  }, [open, resetToSearch]);

  const projects = useMemo(() => listLocalProjects(), [open]);

  const runCommand = useCallback(async (cmd, params) => {
    setLoading(true);
    setMode('result');
    try {
      const data = await executeCommand(cmd.id, params, { adminKey, apiKey });
      setResult({ ok: true, data });
    } catch (err) {
      setResult({ ok: false, error: err.message });
    } finally {
      setLoading(false);
    }
  }, [adminKey, apiKey]);

  const items = useMemo(() => {
    const list = [];
    commands.forEach(cmd => {
      if (cmd.adminOnly && !isAdmin) return;
      if (!fuzzyMatch(q, cmd.label)) return;
      list.push({
        kind: cmd.type === 'nav' ? 'nav' : 'action',
        id: cmd.id,
        label: cmd.label,
        hint: cmd.hint,
        icon: cmd.icon,
        cmd,
      });
    });
    projects.forEach(p => {
      if (fuzzyMatch(q, p.name)) list.push({
        kind: 'project', id: p.id, label: `Switch to ${p.name}`,
        hint: p.github_repo || 'Project', icon: null,
      });
    });
    if (fuzzyMatch(q, 'add project') || fuzzyMatch(q, 'new project')) {
      list.push({ kind: 'special', id: 'add-project', label: 'Add a new project', hint: 'Action', icon: null });
    }
    return list;
  }, [q, projects, isAdmin]);

  function pickItem(item) {
    if (item.kind === 'nav') {
      onNavigate(item.cmd.navTarget);
      onClose();
    } else if (item.kind === 'project') {
      setCurrentProject(item.id);
      onProjectSwitch?.(item.id);
      onClose();
    } else if (item.kind === 'special' && item.id === 'add-project') {
      onAddProject?.();
      onClose();
    } else if (item.kind === 'action' && item.cmd) {
      if (item.cmd.params?.length) {
        setActiveCmd(item.cmd);
        setParamValues({});
        setFocusedParam(0);
        setMode('params');
        setTimeout(() => paramRefs.current[0]?.focus(), 20);
      } else {
        runCommand(item.cmd, {});
      }
    }
  }

  function submitParams() {
    if (!activeCmd) return;
    for (const p of activeCmd.params) {
      if (!paramValues[p.name]?.trim()) return;
    }
    runCommand(activeCmd, paramValues);
  }

  useEffect(() => { if (idx >= items.length) setIdx(0); }, [items, idx]);

  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (mode !== 'search') { resetToSearch(); } else { onClose(); }
        return;
      }
      if (mode === 'params') {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (activeCmd && focusedParam < activeCmd.params.length - 1) {
            const next = focusedParam + 1;
            setFocusedParam(next);
            setTimeout(() => paramRefs.current[next]?.focus(), 10);
          } else {
            submitParams();
          }
        }
        return;
      }
      if (mode === 'result') return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, items.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = items[idx];
        if (item) pickItem(item);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, items, idx, onClose, mode, activeCmd, focusedParam, paramValues, resetToSearch, runCommand]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${idx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] modal-backdrop animate-fade-in-up" onClick={onClose}>
      <div className="cmdk animate-scale-in" onClick={e => e.stopPropagation()}>
        {mode === 'search' && (
          <>
            <div className="flex items-center gap-2 px-3" style={{ borderBottom: '1px solid var(--color-border)' }}>
              <IconSearch width={14} height={14} className="text-[var(--color-foreground-faint)]" />
              <input
                ref={inputRef}
                value={q}
                onChange={e => { setQ(e.target.value); setIdx(0); }}
                placeholder="Search or run command\u2026"
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
                    onClick={() => pickItem(it)}
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
          </>
        )}

        {mode === 'params' && activeCmd && (
          <>
            <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--color-border)' }}>
              <div className="text-[12px] font-medium">{activeCmd.label}</div>
              <div className="text-[11px] text-[var(--color-foreground-faint)]">Fill in the parameters below</div>
            </div>
            <div className="p-3 flex flex-col gap-2">
              {activeCmd.params.map((p, i) => (
                <div key={p.name}>
                  <label className="text-[11px] text-[var(--color-foreground-faint)] mb-1 block">{p.label}</label>
                  <input
                    ref={el => { paramRefs.current[i] = el; }}
                    value={paramValues[p.name] || ''}
                    onChange={e => setParamValues(v => ({ ...v, [p.name]: e.target.value }))}
                    onFocus={() => setFocusedParam(i)}
                    placeholder={p.placeholder}
                    className="cmdk-input"
                  />
                </div>
              ))}
            </div>
          </>
        )}

        {mode === 'result' && (
          <div className="p-3">
            {loading && <div className="text-[12px] text-[var(--color-foreground-faint)]">Running\u2026</div>}
            {result && !loading && (
              <div className={`text-[12px] ${result.ok ? '' : 'text-[var(--color-danger)]'}`}>
                {result.ok ? (
                  <pre className="whitespace-pre-wrap font-mono text-[11px] max-h-[40vh] overflow-auto">{JSON.stringify(result.data, null, 2)}</pre>
                ) : (
                  <div>{result.error}</div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 px-3 py-2 border-t border-[var(--color-border)] text-[10.5px] text-[var(--color-foreground-faint)]">
          {mode === 'search' && (
            <>
              <span className="kbd">↑</span><span className="kbd">↓</span> navigate
              <span className="kbd ml-2">↵</span> select
              <span className="flex-1" />
              <span className="kbd">⌘K</span> toggle
            </>
          )}
          {mode === 'params' && (
            <>
              <span className="kbd">↵</span> {focusedParam < (activeCmd?.params?.length || 1) - 1 ? 'next' : 'run'}
              <span className="flex-1" />
              <span className="kbd">esc</span> back
            </>
          )}
          {mode === 'result' && (
            <>
              <span className="flex-1" />
              <span className="kbd">esc</span> back
            </>
          )}
        </div>
      </div>
    </div>
  );
}
