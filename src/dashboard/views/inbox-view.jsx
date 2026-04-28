// src/dashboard/views/inbox-view.jsx
// The flight-deck Inbox: typed Notify | Question | Review interrupts.
// One row = one decision. j/k navigate, enter open, a/r/d/e act, c capture.
// Replaces today + signals + captures-list + ops-drops.
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ThreadPanel } from '@/components/thread-panel';
import { CaptureComposer } from '@/components/capture-composer';
import {
  IconRefresh, IconClose, IconCapture, IconChevronRight,
  IconExhausted, IconNeedsInput, IconFailed, IconDeploy, IconRunning, IconFinished
} from '@/components/icons';
import { useLiveEvent } from '@/lib/live';

const TYPE_STYLE = {
  REVIEW:   { fg: 'var(--color-error)',   bg: 'var(--color-error-soft)',   label: 'REVIEW'   },
  QUESTION: { fg: 'var(--color-warning)', bg: 'var(--color-warning-soft)', label: 'QUESTION' },
  NOTIFY:   { fg: 'var(--color-info)',    bg: 'var(--color-info-soft)',    label: 'NOTIFY'   },
};

const ORIGIN_ICON = {
  capture:  IconCapture,
  workflow: IconExhausted,
  job:      IconFailed,
  pr:       IconChevronRight,
  deploy:   IconDeploy,
  shelly:   IconNeedsInput,
};

function ageLabel(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60)    return `${seconds}s`;
  if (seconds < 3600)  return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function InboxRow({ item, active, onClick, onAction }) {
  const Icon = ORIGIN_ICON[item.origin] || IconNeedsInput;
  const style = TYPE_STYLE[item.type];
  return (
    <div
      onClick={onClick}
      className={`group flex items-center gap-2 h-8 px-3 cursor-pointer border-l-2 ${active ? 'bg-[var(--color-surface-2)] border-l-[var(--color-foreground)]' : 'border-l-transparent hover:bg-[var(--color-surface-2)]'}`}
      style={{ fontSize: 12, lineHeight: '14px' }}
      data-active={active ? '1' : '0'}
    >
      <span
        className="inline-flex items-center justify-center w-[68px] shrink-0 px-1.5 py-0.5 rounded-sm font-mono uppercase tracking-wider"
        style={{ color: style.fg, background: style.bg, fontSize: 9, fontWeight: 600 }}
      >
        {style.label}
      </span>
      <Icon width={12} height={12} className="shrink-0 text-[var(--color-foreground-faint)]" />
      <span className="text-[var(--color-foreground-faint)] uppercase tracking-wide font-mono shrink-0" style={{ fontSize: 10 }}>
        {item.origin}
      </span>
      {item.project_name && (
        <span className="px-1.5 py-0.5 rounded-sm bg-[var(--color-surface-2)] text-[var(--color-foreground-muted)] shrink-0" style={{ fontSize: 10 }}>
          {item.project_name}
        </span>
      )}
      <span className="flex-1 truncate text-[var(--color-foreground)]">
        {item.title}
      </span>
      <span className="shrink-0 font-mono text-[var(--color-foreground-faint)]" style={{ fontSize: 10 }}>
        {ageLabel(item.age_seconds)}
      </span>
      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); onAction('dismiss', item); }}
          className="text-[10px] px-1.5 h-5 rounded hover:bg-[var(--color-success-soft)] text-[var(--color-foreground-faint)] hover:text-[var(--color-success)] cursor-pointer"
          title="(a)pprove / dismiss"
        >a</button>
        <button
          onClick={(e) => { e.stopPropagation(); onAction('snooze', item); }}
          className="text-[10px] px-1.5 h-5 rounded hover:bg-[var(--color-warning-soft)] text-[var(--color-foreground-faint)] hover:text-[var(--color-warning)] cursor-pointer"
          title="(d)efer 24h"
        >d</button>
      </div>
    </div>
  );
}

function GroupHeader({ label, count, color }) {
  return (
    <div
      className="flex items-center gap-2 px-3 h-7 sticky top-0 z-10"
      style={{
        background: 'var(--color-surface)',
        borderBottom: '1px solid var(--color-border-subtle)',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.08em',
        color: color || 'var(--color-foreground-muted)',
      }}
    >
      <span className="uppercase">{label}</span>
      <span className="font-mono" style={{ color: 'var(--color-foreground-faint)' }}>{count}</span>
    </div>
  );
}

function HelpOverlay({ open, onClose }) {
  if (!open) return null;
  const rows = [
    ['j / k or ↓ ↑', 'next / previous row'],
    ['Enter',         'open detail'],
    ['Esc',           'close detail / overlay'],
    ['a',             'approve / dismiss row'],
    ['d',             'defer 24h (snooze)'],
    ['r',             'restore (undo dismiss)'],
    ['c',             'new capture'],
    ['/',             'focus search'],
    ['1 / 2 / 3',     'filter REVIEW / QUESTION / NOTIFY'],
    ['0',             'clear type filter'],
    ['?',             'this help'],
  ];
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center modal-backdrop" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="rounded-md p-5 max-w-md w-full" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <div className="flex items-center mb-3">
          <h2 className="text-sm font-semibold flex-1">Inbox shortcuts</h2>
          <button onClick={onClose} className="cursor-pointer text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)]"><IconClose width={14} height={14} /></button>
        </div>
        <table className="w-full text-[12px]">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td className="py-1 pr-3"><span className="kbd">{k}</span></td>
                <td className="py-1 text-[var(--color-foreground-muted)]">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function InboxView({ apiUrl, apiKey, refreshKey }) {
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({ total: 0, REVIEW: 0, QUESTION: 0, NOTIFY: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [typeFilter, setTypeFilter] = useState(null);
  const [search, setSearch] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const searchRef = useRef(null);
  const listRef = useRef(null);

  const load = useCallback(async () => {
    if (!apiKey) return;
    try {
      const url = typeFilter
        ? `${apiUrl}/api/inbox?type=${typeFilter}`
        : `${apiUrl}/api/inbox`;
      const r = await fetch(url, { headers: { 'X-API-Key': apiKey } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setItems(d.items || []);
      setCounts(d.counts || { total: 0, REVIEW: 0, QUESTION: 0, NOTIFY: 0 });
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, apiKey, typeFilter]);

  useEffect(() => { load(); }, [load, refreshKey]);
  // Live push: any new capture, workflow status flip, or agent step refetches
  // the inbox. Polling stays as a 30s safety net for tabs the browser
  // throttled (EventSource gets paused in background tabs after a minute).
  useLiveEvent('inbox:invalidate', () => { load(); }, { apiUrl, apiKey });
  useLiveEvent('workflow:changed', () => { load(); }, { apiUrl, apiKey });
  useLiveEvent('ticket:created',   () => { load(); }, { apiUrl, apiKey });
  useLiveEvent('ticket:updated',   () => { load(); }, { apiUrl, apiKey });
  useEffect(() => {
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  // Filter + search
  const visible = useMemo(() => {
    if (!search) return items;
    const q = search.toLowerCase();
    return items.filter(it =>
      (it.title || '').toLowerCase().includes(q)
      || (it.project_name || '').toLowerCase().includes(q)
      || (it.subject_id || '').toLowerCase().includes(q)
    );
  }, [items, search]);

  // Group by type for visual sectioning. Order: REVIEW → QUESTION → NOTIFY.
  const grouped = useMemo(() => {
    const g = { REVIEW: [], QUESTION: [], NOTIFY: [] };
    for (const it of visible) {
      if (g[it.type]) g[it.type].push(it);
    }
    return g;
  }, [visible]);

  // Flat list (matches grouped order) for j/k navigation indexing.
  const flat = useMemo(() => [...grouped.REVIEW, ...grouped.QUESTION, ...grouped.NOTIFY], [grouped]);
  useEffect(() => {
    if (activeIdx >= flat.length) setActiveIdx(Math.max(0, flat.length - 1));
  }, [flat.length, activeIdx]);

  const active = flat[activeIdx];

  const act = useCallback(async (action, item) => {
    if (!item) return;
    try {
      const r = await fetch(`${apiUrl}/api/inbox/${item.subject_type}/${item.subject_id}/${action}`, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // Optimistic remove (dismiss/snooze) — fast feedback. Reload for truth.
      if (action === 'dismiss' || action === 'snooze') {
        setItems(curr => curr.filter(i => i.id !== item.id));
      }
      load();
    } catch (e) {
      setError(e.message);
    }
  }, [apiUrl, apiKey, load]);

  // Keyboard map. Handles all single-key shortcuts when no input is focused
  // and no modal is open (composer/help own Esc themselves).
  useEffect(() => {
    function onKey(e) {
      // If user is typing in an input/textarea, only honour Esc.
      const inField = ['INPUT', 'TEXTAREA'].includes(e.target.tagName);
      if (inField && e.key !== 'Escape') return;
      if (helpOpen || composerOpen) return; // their own handlers run

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          setActiveIdx(i => Math.min(i + 1, flat.length - 1));
          return;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          setActiveIdx(i => Math.max(0, i - 1));
          return;
        case 'Enter':
          e.preventDefault();
          if (active) setDetailOpen(true);
          return;
        case 'Escape':
          if (detailOpen) { setDetailOpen(false); return; }
          searchRef.current?.blur();
          return;
        case 'a':
          if (active) act('dismiss', active);
          return;
        case 'd':
          if (active) act('snooze', active);
          return;
        case 'r':
          if (active) act('restore', active);
          return;
        case 'c':
          e.preventDefault();
          setComposerOpen(true);
          return;
        case '/':
          e.preventDefault();
          searchRef.current?.focus();
          return;
        case '?':
          e.preventDefault();
          setHelpOpen(true);
          return;
        case '1': setTypeFilter('REVIEW'); return;
        case '2': setTypeFilter('QUESTION'); return;
        case '3': setTypeFilter('NOTIFY'); return;
        case '0': setTypeFilter(null); return;
        default: break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flat.length, active, act, detailOpen, helpOpen, composerOpen]);

  // Scroll active row into view when it changes
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* List pane */}
      <div className="flex-1 flex flex-col min-w-0 border-r border-[var(--color-border-subtle)]">
        {/* Header */}
        <div className="flex items-center gap-3 h-12 px-4 border-b border-[var(--color-border-subtle)] shrink-0">
          <h1 className="text-[14px] font-semibold tracking-tight">Inbox</h1>
          <span className="text-[11px] text-[var(--color-foreground-faint)]">{counts.total} interrupt{counts.total === 1 ? '' : 's'}</span>
          <div className="flex-1" />
          <div className="flex items-center gap-1">
            {[
              { key: null,        label: `all ${counts.total}`,            color: null },
              { key: 'REVIEW',    label: `review ${counts.REVIEW}`,        color: TYPE_STYLE.REVIEW },
              { key: 'QUESTION',  label: `question ${counts.QUESTION}`,    color: TYPE_STYLE.QUESTION },
              { key: 'NOTIFY',    label: `notify ${counts.NOTIFY}`,        color: TYPE_STYLE.NOTIFY },
            ].map(f => (
              <button
                key={f.key || 'all'}
                onClick={() => setTypeFilter(f.key)}
                className={`px-2 h-6 rounded text-[10.5px] uppercase tracking-wider font-medium cursor-pointer transition-colors ${typeFilter === f.key ? 'bg-[var(--color-surface-2)] text-[var(--color-foreground)]' : 'text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)]'}`}
                style={typeFilter === f.key && f.color ? { color: f.color.fg } : undefined}
              >
                {f.label}
              </button>
            ))}
          </div>
          <input
            ref={searchRef}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="search…  (/)"
            className="px-2 h-7 text-[12px] rounded outline-none w-44"
            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
          />
          <button onClick={() => setComposerOpen(true)}
            className="h-7 px-2 rounded text-[11px] cursor-pointer flex items-center gap-1"
            style={{ background: 'var(--color-foreground)', color: 'var(--color-background)' }}
            title="(c)apture a thought"
          >
            <IconCapture width={12} height={12} /> capture
          </button>
          <button onClick={() => setHelpOpen(true)}
            className="h-7 w-7 rounded text-[12px] cursor-pointer text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)]"
            title="shortcuts (?)">?</button>
          <button onClick={load} className="h-7 w-7 rounded cursor-pointer text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)]" title="refresh">
            <IconRefresh width={12} height={12} className="mx-auto" />
          </button>
        </div>

        {/* List */}
        <div ref={listRef} className="flex-1 overflow-auto">
          {error && (
            <div className="px-4 py-3 text-[12px] text-[var(--color-error)]">Error: {error}</div>
          )}
          {!loading && flat.length === 0 && (
            <div className="px-6 py-16 text-center">
              <div className="text-[var(--color-foreground-faint)] text-[12px] mb-1">Inbox zero.</div>
              <div className="text-[11px] text-[var(--color-foreground-faint)]">Nothing on you. Press <span className="kbd">c</span> to drop a thought.</div>
            </div>
          )}

          {grouped.REVIEW.length > 0 && (
            <>
              <GroupHeader label="Review" count={grouped.REVIEW.length} color={TYPE_STYLE.REVIEW.fg} />
              {grouped.REVIEW.map((it, i) => {
                const idx = i;
                return (
                  <div key={it.id} data-idx={idx}>
                    <InboxRow item={it} active={activeIdx === idx} onClick={() => { setActiveIdx(idx); setDetailOpen(true); }} onAction={act} />
                  </div>
                );
              })}
            </>
          )}
          {grouped.QUESTION.length > 0 && (
            <>
              <GroupHeader label="Question" count={grouped.QUESTION.length} color={TYPE_STYLE.QUESTION.fg} />
              {grouped.QUESTION.map((it, i) => {
                const idx = grouped.REVIEW.length + i;
                return (
                  <div key={it.id} data-idx={idx}>
                    <InboxRow item={it} active={activeIdx === idx} onClick={() => { setActiveIdx(idx); setDetailOpen(true); }} onAction={act} />
                  </div>
                );
              })}
            </>
          )}
          {grouped.NOTIFY.length > 0 && (
            <>
              <GroupHeader label="Notify" count={grouped.NOTIFY.length} color={TYPE_STYLE.NOTIFY.fg} />
              {grouped.NOTIFY.map((it, i) => {
                const idx = grouped.REVIEW.length + grouped.QUESTION.length + i;
                return (
                  <div key={it.id} data-idx={idx}>
                    <InboxRow item={it} active={activeIdx === idx} onClick={() => { setActiveIdx(idx); setDetailOpen(true); }} onAction={act} />
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* Detail rail — mounts ThreadPanel for capture/work_item, generic info for others */}
      {detailOpen && active && (
        <div className="w-[440px] shrink-0 flex flex-col bg-[var(--color-surface)] border-l border-[var(--color-border-subtle)]">
          {(active.subject_type === 'capture' || active.subject_type === 'work_item' || active.subject_type === 'ticket') ? (
            <ThreadPanel
              subject={{ subject_type: active.subject_type, subject_id: active.subject_id, project_id: active.project_id }}
              apiUrl={apiUrl}
              apiKey={apiKey}
              onClose={() => setDetailOpen(false)}
            />
          ) : (
            <GenericDetail item={active} onClose={() => setDetailOpen(false)} onAction={act} />
          )}
        </div>
      )}

      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      <CaptureComposer
        open={composerOpen}
        apiUrl={apiUrl}
        apiKey={apiKey}
        onClose={() => setComposerOpen(false)}
        onCreated={() => { setComposerOpen(false); load(); }}
      />
    </div>
  );
}

function GenericDetail({ item, onClose, onAction }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 h-12 px-4 border-b border-[var(--color-border-subtle)]">
        <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-sm"
          style={{ color: TYPE_STYLE[item.type].fg, background: TYPE_STYLE[item.type].bg }}>
          {item.type}
        </span>
        <span className="text-[11px] text-[var(--color-foreground-faint)] uppercase">{item.origin}</span>
        <div className="flex-1" />
        <button onClick={onClose} className="cursor-pointer text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)]"><IconClose width={14} height={14} /></button>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-3">
        <div className="text-[14px] text-[var(--color-foreground)]">{item.title}</div>
        <dl className="text-[11px] space-y-1.5">
          <div className="flex"><dt className="w-28 text-[var(--color-foreground-faint)]">Subject</dt><dd className="font-mono text-[var(--color-foreground-muted)]">{item.subject_type}/{item.subject_id}</dd></div>
          {item.project_name && <div className="flex"><dt className="w-28 text-[var(--color-foreground-faint)]">Project</dt><dd>{item.project_name}</dd></div>}
          {item.signal_type && <div className="flex"><dt className="w-28 text-[var(--color-foreground-faint)]">Signal</dt><dd className="font-mono">{item.signal_type}</dd></div>}
          {item.agent && <div className="flex"><dt className="w-28 text-[var(--color-foreground-faint)]">Agent</dt><dd>{item.agent}</dd></div>}
          <div className="flex"><dt className="w-28 text-[var(--color-foreground-faint)]">Age</dt><dd>{ageLabel(item.age_seconds)}</dd></div>
          {item.snoozed_until && <div className="flex"><dt className="w-28 text-[var(--color-foreground-faint)]">Snoozed until</dt><dd>{new Date(item.snoozed_until).toLocaleString()}</dd></div>}
        </dl>
      </div>
      <div className="flex items-center gap-2 px-3 py-2 border-t border-[var(--color-border-subtle)]">
        <button onClick={() => onAction('dismiss', item)} className="px-3 h-7 rounded text-[11px] cursor-pointer" style={{ background: 'var(--color-success-soft)', color: 'var(--color-success)' }}>Dismiss (a)</button>
        <button onClick={() => onAction('snooze', item)} className="px-3 h-7 rounded text-[11px] cursor-pointer" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning)' }}>Defer 24h (d)</button>
        <div className="flex-1" />
        <button onClick={() => onAction('restore', item)} className="px-3 h-7 rounded text-[11px] cursor-pointer text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)]">Restore (r)</button>
      </div>
    </div>
  );
}
