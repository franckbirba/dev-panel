# Signal Inbox UI (Stage 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Signals UI — a cross-project cockpit replacing Today/Captures/Inbox/Dashboard with a unified signal feed, thread panel, priority lanes, and paste-URL project add.

**Architecture:** New `/dashboard/signals` route behind a localStorage feature flag. Seven new components under `src/dashboard/views/` and `src/dashboard/components/`. Consumes the Stage 1 backend endpoints (`GET /api/signals`, `GET/POST /api/threads`, `PATCH /api/subjects`, `POST /api/projects/from-github`). SSE-driven live updates via admin stream. Old views remain default until Stage 3.

**Tech Stack:** React 19, Tailwind CSS v4, CVA (class-variance-authority), Vite, existing `@/` alias, existing SSE infrastructure (`subscribeAdminEvents`).

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/dashboard/views/signals-view.jsx` | **Create** | Top-level view: fetches signals, manages filter/thread state, wires SSE |
| `src/dashboard/components/signal-row.jsx` | **Create** | Single signal row with priority dots, project chip, type icon, age |
| `src/dashboard/components/priority-buttons.jsx` | **Create** | Three-dot priority selector (now/today/later) with optimistic update |
| `src/dashboard/components/filter-bar.jsx` | **Create** | Priority + project + type multi-select filters, URL query sync |
| `src/dashboard/components/thread-panel.jsx` | **Create** | Right-side slide-in: thread header, message list, reply box |
| `src/dashboard/components/paste-url-modal.jsx` | **Create** | One-field modal for GitHub URL → bootstrap |
| `src/dashboard/lib/use-signals.js` | **Create** | Custom hook: fetch signals, SSE live updates, filter logic |
| `src/dashboard/app.jsx` | **Modify** | Add signals tab, feature flag routing |
| `src/dashboard/components/tab-bar.jsx` | **Modify** | Add "Signals" tab entry |
| `src/dashboard/views/settings-view.jsx` | **Modify** | Add feature flag toggle |

---

### Task 1: Feature flag + signals tab wiring

Wire the "Signals" tab into the app shell behind a localStorage feature flag. No view content yet — just a placeholder that proves routing works.

**Files:**
- Modify: `src/dashboard/app.jsx`
- Modify: `src/dashboard/components/tab-bar.jsx`
- Modify: `src/dashboard/views/settings-view.jsx`
- Create: `src/dashboard/views/signals-view.jsx`

- [ ] **Step 1: Create signals-view.jsx placeholder**

```jsx
// src/dashboard/views/signals-view.jsx
export function SignalsView({ apiUrl, apiKey, adminKey }) {
  return (
    <div className="h-full flex items-center justify-center">
      <span className="text-muted-foreground text-sm">Signals view loading…</span>
    </div>
  );
}
```

- [ ] **Step 2: Add feature flag to settings-view.jsx**

In `src/dashboard/views/settings-view.jsx`, add a "Features" section to the sidebar nav and content area.

Add to the `sections` array (before "danger"):
```jsx
{ id: "features", label: "Features" },
```

Add `SECTION_ICONS.features`:
```jsx
features: (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M12 2L2 7l10 5 10-5-10-5z" />
    <path d="M2 17l10 5 10-5" />
    <path d="M2 12l10 5 10-5" />
  </svg>
),
```

Add content block for `section === "features"`:
```jsx
{section === "features" && (
  <>
    <SectionHeader
      title="Features"
      description="Try experimental features before they become the default."
    />
    <div className="flex flex-col gap-4 mt-4">
      <div className="card-glow rounded-xl p-4 flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <span className="text-foreground text-[13px] font-medium">Signals view</span>
          <span className="text-muted-foreground/50 text-[11px]">
            Cross-project signal feed replacing Today/Captures/Dashboard.
          </span>
        </div>
        <button
          onClick={() => {
            const current = localStorage.getItem('devpanel_signals_enabled') === 'true';
            localStorage.setItem('devpanel_signals_enabled', String(!current));
            window.location.reload();
          }}
          className={`px-3 py-1.5 rounded-lg text-xs font-mono cursor-pointer transition-colors ${
            localStorage.getItem('devpanel_signals_enabled') === 'true'
              ? 'bg-success/15 text-success'
              : 'bg-secondary text-muted-foreground'
          }`}
        >
          {localStorage.getItem('devpanel_signals_enabled') === 'true' ? 'ON' : 'OFF'}
        </button>
      </div>
    </div>
  </>
)}
```

- [ ] **Step 3: Wire signals tab into app.jsx**

Add import at top:
```jsx
import { SignalsView } from "@/views/signals-view";
```

Update `getInitialTab()` — add before the `/dashboard/` line:
```jsx
if (path.includes("/signals")) return "signals";
```

Update `handleTabChange()` path mapping — add case:
```jsx
: tab === "signals" ? "/dashboard/signals"
```

Add view rendering in the main content area, before the `activeTab === "today"` line:
```jsx
{activeTab === "signals" && <SignalsView apiUrl={apiUrl} apiKey={apiKey} adminKey={getAdminKey()} />}
```

Add import for `getAdminKey`:
```jsx
import {
  migrateLegacy, listLocalProjects, getCurrentProject, addOrUpdateProject, getAdminKey
} from "@/lib/projects-store";
```

- [ ] **Step 4: Add Signals tab to tab-bar.jsx**

Insert at position 0 in the `tabs` array (before "today"), conditionally:
```jsx
const signalsEnabled = localStorage.getItem('devpanel_signals_enabled') === 'true';

const tabs = [
  ...(signalsEnabled ? [{ id: "signals", label: "Signals" }] : []),
  { id: "today", label: "Today" },
  // ... rest unchanged
];
```

- [ ] **Step 5: Verify manually**

Run: `npx vite dev` (or whatever the dev command is).
1. Open `/dashboard/settings` → Features → toggle ON → page reloads.
2. "Signals" tab appears in the tab bar.
3. Click it → shows placeholder text, URL becomes `/dashboard/signals`.
4. Toggle OFF → "Signals" tab disappears, old views remain.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/views/signals-view.jsx src/dashboard/app.jsx src/dashboard/components/tab-bar.jsx src/dashboard/views/settings-view.jsx
git commit -m "feat(ui): signals tab + feature flag toggle in settings"
```

---

### Task 2: use-signals hook — data fetching + SSE live updates

Custom hook that fetches `/api/signals`, subscribes to admin SSE for live updates, and exposes filtered/grouped data.

**Files:**
- Create: `src/dashboard/lib/use-signals.js`

- [ ] **Step 1: Create use-signals.js**

```jsx
// src/dashboard/lib/use-signals.js
import { useState, useEffect, useCallback, useRef } from 'react';
import { subscribeAdminEvents } from './events.js';
import { getAdminKey } from './projects-store.js';

const POLL_MS = 15_000;

export function useSignals({ apiUrl, apiKey, filters = {} }) {
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const signalsRef = useRef(signals);
  signalsRef.current = signals;

  const fetchSignals = useCallback(async () => {
    if (!apiKey) return;
    const params = new URLSearchParams();
    if (filters.project) params.set('project_id', filters.project);
    if (filters.priority) params.set('priority', filters.priority);
    if (filters.needs_me_only) params.set('needs_me_only', '1');
    try {
      const r = await fetch(`${apiUrl}/api/signals?${params}`, {
        headers: { 'X-Admin-Key': getAdminKey() || undefined, 'X-API-Key': apiKey }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setSignals(data.signals || data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, apiKey, filters.project, filters.priority, filters.needs_me_only]);

  // Initial fetch + polling
  useEffect(() => { fetchSignals(); }, [fetchSignals]);
  useEffect(() => {
    const id = setInterval(fetchSignals, POLL_MS);
    return () => clearInterval(id);
  }, [fetchSignals]);

  // SSE live updates
  useEffect(() => {
    const adminKey = getAdminKey();
    if (!adminKey) return;
    const unsub = subscribeAdminEvents(adminKey, (type, data) => {
      if (type === 'signal:new') {
        setSignals(prev => [data, ...prev.filter(s =>
          !(s.subject_type === data.subject_type && s.subject_id === data.subject_id)
        )]);
      }
      if (type === 'subject:priority_changed') {
        setSignals(prev => prev.map(s =>
          s.subject_type === data.subject_type && s.subject_id === data.subject_id
            ? { ...s, priority: data.priority }
            : s
        ));
      }
      if (type === 'signal:resolved') {
        setSignals(prev => prev.filter(s =>
          !(s.subject_type === data.subject_type && s.subject_id === data.subject_id)
        ));
      }
    });
    return unsub;
  }, []);

  // Group into urgency bands
  const grouped = {
    needs_attention: signals.filter(s => s.urgency === 'needs_attention'),
    in_flight: signals.filter(s => s.urgency === 'in_flight'),
    fyi: signals.filter(s => s.urgency === 'fyi'),
  };

  return { signals, grouped, loading, error, refetch: fetchSignals };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/lib/use-signals.js
git commit -m "feat(ui): use-signals hook with SSE live updates"
```

---

### Task 3: SignalRow + PriorityButtons components

The visual row for each signal in the feed, and the three-dot priority selector.

**Files:**
- Create: `src/dashboard/components/priority-buttons.jsx`
- Create: `src/dashboard/components/signal-row.jsx`

- [ ] **Step 1: Create priority-buttons.jsx**

```jsx
// src/dashboard/components/priority-buttons.jsx
import { useState } from 'react';

const LANES = [
  { id: 'now', color: 'bg-error', label: 'Now' },
  { id: 'today', color: 'bg-warning', label: 'Today' },
  { id: 'later', color: 'bg-muted-foreground', label: 'Later' },
];

export function PriorityButtons({ current, onSet, disabled }) {
  const [optimistic, setOptimistic] = useState(null);
  const active = optimistic ?? current;

  async function handleClick(lane) {
    const next = active === lane ? null : lane;
    setOptimistic(next);
    try {
      await onSet(next);
    } catch {
      setOptimistic(null);
    }
  }

  return (
    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
      {LANES.map(l => (
        <button
          key={l.id}
          onClick={() => handleClick(l.id)}
          disabled={disabled}
          title={l.label}
          className={`w-3.5 h-3.5 rounded-full border transition-all cursor-pointer disabled:cursor-default ${
            active === l.id
              ? `${l.color} border-transparent scale-110`
              : `border-border hover:border-muted-foreground/60`
          }`}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create signal-row.jsx**

```jsx
// src/dashboard/components/signal-row.jsx
import { PriorityButtons } from './priority-buttons';

const PRIORITY_EDGE = {
  now: 'border-l-error',
  today: 'border-l-warning',
  later: 'border-l-muted-foreground/40',
};

const TYPE_ICONS = {
  workflow_exhausted: '✗',
  workflow_needs_input: '?',
  workflow_running: '↻',
  workflow_finished: '✓',
  failed_job: '!',
  capture: '◉',
  deploy_failed: '↯',
  deploy_succeeded: '↑',
  ticket: '▣',
};

const URGENCY_ACCENT = {
  needs_attention: 'bg-error/10',
  in_flight: 'bg-info/10',
  fyi: 'bg-success/10',
};

function timeAgo(min) {
  if (min == null || !Number.isFinite(min)) return '—';
  if (min < 1) return 'now';
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}

export function SignalRow({ signal, onSelect, onPrioritySet, isSelected }) {
  const edge = PRIORITY_EDGE[signal.priority] || 'border-l-transparent';
  const icon = TYPE_ICONS[signal.signal_type] || '·';
  const accent = URGENCY_ACCENT[signal.urgency] || '';

  return (
    <button
      onClick={() => onSelect(signal)}
      className={`w-full text-left flex items-center gap-3 px-4 py-3 border-l-[3px] ${edge} transition-colors cursor-pointer
        ${isSelected ? 'bg-secondary/50' : `hover:bg-secondary/30 ${accent}`}`}
    >
      <div className={`w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-mono font-bold shrink-0
        ${signal.urgency === 'needs_attention' ? 'bg-error/15 text-error' :
          signal.urgency === 'in_flight' ? 'bg-info/15 text-info' :
          'bg-success/15 text-success'}`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] text-muted-foreground/60 font-mono">
            {signal.project_name || signal.project_id?.slice(0, 8)} · {signal.subject_type || signal.signal_type}
          </span>
          {signal.has_screenshot && (
            <span className="text-[10px]" title="Has screenshot">📷</span>
          )}
        </div>
        <div className="text-xs truncate">{signal.title}</div>
      </div>
      <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
        {timeAgo(signal.age_min)}
      </span>
      <PriorityButtons
        current={signal.priority}
        onSet={(p) => onPrioritySet(signal.subject_type, signal.subject_id, p)}
      />
    </button>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/components/priority-buttons.jsx src/dashboard/components/signal-row.jsx
git commit -m "feat(ui): SignalRow + PriorityButtons components"
```

---

### Task 4: FilterBar component

Priority, project, and type multi-select filters that sync to URL query params.

**Files:**
- Create: `src/dashboard/components/filter-bar.jsx`

- [ ] **Step 1: Create filter-bar.jsx**

```jsx
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
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/filter-bar.jsx
git commit -m "feat(ui): FilterBar with priority/project/type chips + URL sync"
```

---

### Task 5: ThreadPanel component

Right-side slide-in panel showing thread header, message list, and reply box. Sends replies via `POST /api/threads/:type/:id/messages`, receives live messages via SSE.

**Files:**
- Create: `src/dashboard/components/thread-panel.jsx`

- [ ] **Step 1: Create thread-panel.jsx**

```jsx
// src/dashboard/components/thread-panel.jsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { subscribeAdminEvents } from '@/lib/events';
import { getAdminKey } from '@/lib/projects-store';

function timeAgo(iso) {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const ROLE_STYLE = {
  user: 'bg-foreground text-background',
  shelly: 'bg-info/15 text-foreground border border-info/30',
  system: 'bg-secondary/50 text-muted-foreground italic',
  agent: 'bg-warning/15 text-foreground border border-warning/30',
};

export function ThreadPanel({ subject, apiUrl, apiKey, onClose }) {
  const [thread, setThread] = useState(null);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef(null);
  const endRef = useRef(null);

  const loadThread = useCallback(async () => {
    if (!subject) return;
    try {
      const r = await fetch(`${apiUrl}/api/threads/${subject.subject_type}/${subject.subject_id}`, {
        headers: { 'X-API-Key': apiKey }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setThread(data.thread);
      setMessages(data.messages || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [apiUrl, apiKey, subject]);

  useEffect(() => { loadThread(); }, [loadThread]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // SSE live messages
  useEffect(() => {
    const adminKey = getAdminKey();
    if (!adminKey || !thread) return;
    const unsub = subscribeAdminEvents(adminKey, (type, data) => {
      if (type === 'thread:message' && data.thread_id === thread.thread_id) {
        setMessages(prev => {
          if (prev.some(m => m.id === data.message.id)) return prev;
          return [...prev, data.message];
        });
      }
    });
    return unsub;
  }, [thread]);

  async function handleSend(e) {
    e.preventDefault();
    const content = inputRef.current?.value.trim();
    if (!content || !subject) return;
    setSending(true);
    try {
      await fetch(`${apiUrl}/api/threads/${subject.subject_type}/${subject.subject_id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ content, role: 'user', source: 'web' })
      });
      inputRef.current.value = '';
      await loadThread();
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend(e);
    }
  }

  if (!subject) return null;

  return (
    <div className="w-[40%] min-w-[360px] max-w-[560px] border-l border-border flex flex-col bg-background h-full">
      {/* Header */}
      <div className="px-5 py-3 border-b border-border flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate">{subject.title || `${subject.subject_type}/${subject.subject_id}`}</div>
          <div className="text-[10px] text-muted-foreground/60 font-mono mt-0.5">
            {subject.project_name || ''} · {subject.subject_type}
          </div>
        </div>
        <button onClick={onClose}
          className="text-muted-foreground hover:text-foreground cursor-pointer text-sm">✕</button>
      </div>

      {error && (
        <div className="px-5 py-2 text-[11px] text-error bg-error/5 border-b border-error/20 font-mono">{error}</div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {messages.map(m => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-lg px-3 py-2 text-xs ${ROLE_STYLE[m.role] || ROLE_STYLE.system}`}>
              {m.role !== 'user' && (
                <div className="text-[10px] font-mono uppercase tracking-wider opacity-60 mb-1">{m.role}</div>
              )}
              <div className="whitespace-pre-wrap">{m.content}</div>
              <div className="text-[10px] opacity-50 mt-1 font-mono">{timeAgo(m.created_at)}</div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Reply box */}
      <form onSubmit={handleSend} className="border-t border-border px-5 py-3 flex items-center gap-2">
        <input
          ref={inputRef}
          onKeyDown={handleKeyDown}
          placeholder="reply to shelly… (Cmd+Enter to send)"
          className="flex-1 h-9 px-3 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring/60"
        />
        <button type="submit" disabled={sending}
          className="h-9 px-3 rounded-md bg-foreground text-background text-xs font-medium disabled:opacity-50 cursor-pointer">
          send
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/thread-panel.jsx
git commit -m "feat(ui): ThreadPanel — slide-in conversation panel with SSE live messages"
```

---

### Task 6: PasteUrlModal component

One-field modal for `POST /api/projects/from-github`. Needs admin key (from localStorage or prompt).

**Files:**
- Create: `src/dashboard/components/paste-url-modal.jsx`

- [ ] **Step 1: Create paste-url-modal.jsx**

```jsx
// src/dashboard/components/paste-url-modal.jsx
import { useState, useRef, useEffect } from 'react';
import { getAdminKey, setAdminKey, addOrUpdateProject } from '@/lib/projects-store';

export function PasteUrlModal({ apiUrl, onClose, onCreated }) {
  const [url, setUrl] = useState('');
  const [adminKeyInput, setAdminKeyInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [step, setStep] = useState(null); // null | 'probing' | 'creating' | 'done'
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);
  const storedKey = getAdminKey();
  const needsKey = !storedKey;

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    const key = storedKey || adminKeyInput.trim();
    if (!key) { setError('Admin key required.'); return; }
    if (!url.trim()) return;

    setBusy(true); setError(null); setStep('probing');
    try {
      const r = await fetch(`${apiUrl}/api/projects/from-github`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
        body: JSON.stringify({ github_url: url.trim() })
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);

      // Persist admin key if it was entered fresh
      if (!storedKey && adminKeyInput.trim()) setAdminKey(adminKeyInput.trim());

      // Add to local store
      if (body.project) {
        addOrUpdateProject(body.project);
      }

      setStep('done');
      setResult(body);
      onCreated?.(body);
    } catch (e) {
      setError(e.message);
      setStep(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <form onSubmit={handleSubmit} onClick={e => e.stopPropagation()}
        className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Add project</h3>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">✕</button>
        </div>

        {step === 'done' && result ? (
          <div className="space-y-3">
            <div className="bg-success/10 text-success rounded-lg px-4 py-3 text-xs font-mono">
              {result.project?.name || 'Project'} created. Bootstrap job queued.
            </div>
            <button type="button" onClick={onClose}
              className="w-full h-9 rounded-lg bg-foreground text-background text-sm font-medium hover:bg-foreground/90 cursor-pointer">
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <label className="block text-[10px] uppercase tracking-wider text-muted-foreground">GitHub repo</label>
              <input
                ref={inputRef}
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
                className="w-full h-9 px-3 rounded-lg border border-border bg-background text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring/60"
              />
            </div>

            {needsKey && (
              <div className="space-y-1.5">
                <label className="block text-[10px] uppercase tracking-wider text-muted-foreground">Admin key</label>
                <input
                  value={adminKeyInput}
                  onChange={e => setAdminKeyInput(e.target.value)}
                  type="password"
                  placeholder="admin key (remembered on this device)"
                  autoComplete="off"
                  className="w-full h-9 px-3 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring/60"
                />
              </div>
            )}

            {error && (
              <div className="text-xs text-error bg-error/10 rounded-lg px-3 py-2 font-mono">{error}</div>
            )}

            {step && (
              <div className="text-[11px] text-muted-foreground font-mono animate-pulse">
                {step === 'probing' ? 'Probing GitHub + creating Plane project…' : step}
              </div>
            )}

            <button type="submit" disabled={busy || !url.trim()}
              className="w-full h-9 rounded-lg bg-foreground text-background text-sm font-medium hover:bg-foreground/90 disabled:opacity-50 cursor-pointer">
              {busy ? 'Working…' : 'Add and bootstrap'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/paste-url-modal.jsx
git commit -m "feat(ui): PasteUrlModal — one-field GitHub project bootstrap"
```

---

### Task 7: Wire everything into SignalsView

Replace the placeholder with the full signals feed using all components built in Tasks 2-6.

**Files:**
- Modify: `src/dashboard/views/signals-view.jsx`

- [ ] **Step 1: Implement the full SignalsView**

Replace the entire content of `src/dashboard/views/signals-view.jsx`:

```jsx
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
        className={`sticky top-0 z-10 w-full flex items-center gap-2 px-4 py-2 bg-surface border-b border-border cursor-pointer`}
      >
        <span className={`w-2 h-2 rounded-full ${color}`} />
        <span className="text-[11px] uppercase tracking-wider font-medium">{title}</span>
        <span className="text-[10px] text-muted-foreground tabular-nums">{count}</span>
        <span className="text-[10px] text-muted-foreground ml-auto">{open ? '▼' : '▸'}</span>
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
  const [selected, setSelected] = useState(null); // { subject_type, subject_id, title, project_name }
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
              <span className="text-muted-foreground text-xs animate-pulse">Loading signals…</span>
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
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/views/signals-view.jsx
git commit -m "feat(ui): full SignalsView — feed, bands, threads, paste-URL"
```

---

### Task 8: Add paste-URL button to Projects tab

Wire the PasteUrlModal into the existing Projects view as an alternative to the form-heavy "New project" modal.

**Files:**
- Modify: `src/dashboard/views/projects-view.jsx`

- [ ] **Step 1: Add paste-URL button to projects-view.jsx**

Add import at top:
```jsx
import { PasteUrlModal } from '@/components/paste-url-modal';
```

Add state:
```jsx
const [showPasteUrl, setShowPasteUrl] = useState(false);
```

Add a button next to the existing `+ New project` button (inside the header `<div className="flex-1" />` after-sibling):
```jsx
<button onClick={() => setShowPasteUrl(true)}
  className="px-3 py-1 text-xs rounded-md bg-success/15 text-success hover:bg-success/20 cursor-pointer mr-2">
  + From GitHub URL
</button>
```

Add modal rendering at the end of the return, before the closing `</div>`:
```jsx
{showPasteUrl && (
  <PasteUrlModal
    apiUrl={apiUrl}
    onClose={() => setShowPasteUrl(false)}
    onCreated={() => { setShowPasteUrl(false); refresh(); loadSummary(); onProjectChange?.(); }}
  />
)}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/views/projects-view.jsx
git commit -m "feat(ui): paste-URL bootstrap button on Projects tab"
```

---

### Task 9: Responsive thread panel + polish

Below 768px viewport, the thread panel should be a full-screen takeover instead of a side panel. Add new-row highlight animation.

**Files:**
- Modify: `src/dashboard/components/thread-panel.jsx`
- Modify: `src/dashboard/app.css`

- [ ] **Step 1: Make ThreadPanel responsive**

In `thread-panel.jsx`, change the root div's className to handle mobile:
```jsx
<div className="w-full md:w-[40%] md:min-w-[360px] md:max-w-[560px] fixed md:relative inset-0 md:inset-auto border-l border-border flex flex-col bg-background h-full z-30">
```

Add a back button visible only on mobile, inside the header before the close button:
```jsx
<button onClick={onClose}
  className="md:hidden text-muted-foreground hover:text-foreground cursor-pointer text-xs mr-2">← back</button>
```

- [ ] **Step 2: Add highlight animation to app.css**

Append to `@layer components` in `app.css`:
```css
/* Signal row highlight on SSE insert */
@keyframes signal-highlight {
  0% { background-color: rgba(59, 130, 246, 0.15); }
  100% { background-color: transparent; }
}
.signal-new {
  animation: signal-highlight 2s ease-out;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/components/thread-panel.jsx src/dashboard/app.css
git commit -m "feat(ui): responsive thread panel + signal highlight animation"
```

---

### Task 10: Vite build verification + final cleanup

Make sure the dashboard builds cleanly with all new files, no import errors.

**Files:**
- None new — verification only

- [ ] **Step 1: Run Vite build**

Run: `npx vite build`
Expected: Build succeeds with no errors. Check that all new components are tree-shaken behind the feature flag correctly (they won't be — dynamic imports would be needed for that, but the static imports are fine for Stage 2 since the flag only hides the tab, not the bundle).

- [ ] **Step 2: Run existing tests**

Run: `npx vitest run`
Expected: All backend tests still pass (UI has no tests in this project — pure React components tested via manual/visual).

- [ ] **Step 3: Manual smoke test**

1. `npx vite dev` — open `/dashboard/settings` → Features → toggle Signals ON.
2. Signals tab appears. Click it.
3. If no admin key: empty state with "Add a project" button.
4. If admin key + projects exist: signal feed loads with three bands.
5. Click a row → thread panel slides in from right.
6. Type a reply → sends to API.
7. On mobile (resize to <768px) → thread panel goes fullscreen with back button.
8. Filter chips work — URL updates.
9. Priority dots work — clicking sets priority, row gets colored left edge.
10. Projects tab → "From GitHub URL" button opens the paste-URL modal.

- [ ] **Step 4: Commit any fixes from smoke test**

```bash
git add -p  # review each hunk
git commit -m "fix(ui): smoke test fixes for signals view"
```

---

## Summary

| Task | What | Commit message |
|------|------|----------------|
| 1 | Feature flag + signals tab wiring | `feat(ui): signals tab + feature flag toggle in settings` |
| 2 | use-signals hook | `feat(ui): use-signals hook with SSE live updates` |
| 3 | SignalRow + PriorityButtons | `feat(ui): SignalRow + PriorityButtons components` |
| 4 | FilterBar | `feat(ui): FilterBar with priority/project/type chips + URL sync` |
| 5 | ThreadPanel | `feat(ui): ThreadPanel — slide-in conversation panel with SSE live messages` |
| 6 | PasteUrlModal | `feat(ui): PasteUrlModal — one-field GitHub project bootstrap` |
| 7 | Wire into SignalsView | `feat(ui): full SignalsView — feed, bands, threads, paste-URL` |
| 8 | Paste-URL on Projects tab | `feat(ui): paste-URL bootstrap button on Projects tab` |
| 9 | Responsive + polish | `feat(ui): responsive thread panel + signal highlight animation` |
| 10 | Build verification | `fix(ui): smoke test fixes for signals view` |
