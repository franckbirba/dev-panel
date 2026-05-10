// src/dashboard/views/fleet-live-view.jsx
//
// Fleet · live — keeps the layout and features from the design's
// fleet-live.html (totals strip, filter chips, per-agent progress with
// tokens + spend, state-aware row actions, narrative task line, side
// chat panel) but renders with the **production design system**:
//   - var(--color-*) tokens from src/dashboard/app.css
//   - Inter for body, JetBrains Mono for state/counts/ids
//   - dark surface ramp (--color-surface-1/2/3), 1px borders, 6/8px radii
//   - status palette as soft+border (12%/32% alpha), pure colour on text
//
// No phone mock. No serif. The chat panel is a flat panel using the
// same surface tokens as the rest of the dashboard.
import { useEffect, useMemo, useRef, useState } from 'react';

const STYLES = `
  .fleet-live { display:flex; flex-direction:column; height:100%; overflow:hidden;
    background:var(--color-background); color:var(--color-foreground);
    font-family:var(--font-sans, Inter, system-ui, sans-serif); }
  .fleet-live * { box-sizing:border-box }

  /* Top strip — clock, project, sync state. Surface-1 + subtle border. */
  .fleet-live__top { display:flex; align-items:center; gap:12px; height:44px;
    padding:0 16px; background:var(--color-surface-1);
    border-bottom:1px solid var(--color-border-subtle); flex-shrink:0;
    font-family:var(--font-mono); font-size:11px; color:var(--color-foreground-muted);
    letter-spacing:0.02em; }
  .fleet-live__top-title { font-family:var(--font-sans); font-weight:600; font-size:13px;
    color:var(--color-foreground); letter-spacing:-0.01em }
  .fleet-live__top-pad { flex:1 }
  .fleet-live__dot { width:6px; height:6px; border-radius:50%; display:inline-block;
    margin:0 6px 0 4px }

  .fleet-live__grid { flex:1; display:grid; grid-template-columns:1fr 380px; min-height:0 }

  .fleet-live__main { display:flex; flex-direction:column; min-height:0;
    border-right:1px solid var(--color-border-subtle) }

  /* Header band — title + meta + filter chips */
  .fleet-live__header { padding:14px 20px;
    border-bottom:1px solid var(--color-border-subtle);
    display:flex; align-items:center; gap:14px; flex-wrap:wrap }
  .fleet-live__h1 { margin:0; font-family:var(--font-sans); font-weight:600;
    font-size:15px; color:var(--color-foreground); letter-spacing:-0.01em }
  .fleet-live__meta { font-family:var(--font-mono); font-size:11px;
    color:var(--color-foreground-faint); letter-spacing:0.02em }
  .fleet-live__pad { flex:1 }
  .fleet-live__chip { font-family:var(--font-mono); font-size:11px; font-weight:500;
    text-transform:lowercase; letter-spacing:0.04em;
    padding:4px 10px; border-radius:6px; cursor:pointer;
    background:transparent; border:1px solid transparent;
    color:var(--color-foreground-muted);
    transition:color 120ms, background 120ms, border-color 120ms }
  .fleet-live__chip:hover { color:var(--color-foreground); background:var(--color-surface-2) }
  .fleet-live__chip.is-active { color:var(--color-foreground);
    background:var(--color-surface-2); border-color:var(--color-border) }

  /* 5-cell totals strip */
  .fleet-live__totals { display:flex;
    border-bottom:1px solid var(--color-border-subtle);
    background:var(--color-surface-1) }
  .fleet-live__cell { flex:1; padding:14px 20px;
    border-right:1px solid var(--color-border-subtle);
    display:flex; flex-direction:column; gap:4px }
  .fleet-live__cell:last-child { border-right:none }
  .fleet-live__cell-n { font-family:var(--font-mono); font-weight:600; font-size:22px;
    line-height:1; font-variant-numeric:tabular-nums;
    color:var(--c, var(--color-foreground)); letter-spacing:-0.01em }
  .fleet-live__cell-l { font-family:var(--font-mono); font-size:9.5px;
    color:var(--color-foreground-faint); text-transform:uppercase; letter-spacing:0.12em }

  /* Stream of agent rows */
  .fleet-live__stream { flex:1; overflow-y:auto }
  .fleet-live__empty { padding:48px 20px; text-align:center;
    color:var(--color-foreground-faint); font-size:12px }

  .fleet-live__row { display:grid;
    grid-template-columns: 88px 1fr 200px auto;
    gap:16px; padding:14px 20px;
    border-bottom:1px solid var(--color-border-subtle);
    align-items:center; transition:background 120ms }
  .fleet-live__row:hover { background:var(--color-surface-2) }

  /* Status badge — soft+border per the design system */
  .fleet-live__badge { font-family:var(--font-mono); font-size:9.5px; font-weight:600;
    letter-spacing:0.12em; text-transform:uppercase;
    padding:3px 6px; border-radius:4px;
    color:var(--c); background:var(--c-soft); border:1px solid var(--c-border);
    text-align:center; line-height:1.4 }

  .fleet-live__title-line { display:flex; align-items:baseline; gap:10px; margin-bottom:3px;
    min-width:0 }
  .fleet-live__title { font-family:var(--font-sans); font-weight:500; font-size:13px;
    color:var(--color-foreground); letter-spacing:-0.005em;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0 }
  .fleet-live__ref { font-family:var(--font-mono); font-size:10.5px;
    color:var(--color-foreground-faint); letter-spacing:0.03em; flex-shrink:0 }
  .fleet-live__task { font-family:var(--font-sans); font-size:12px;
    color:var(--color-foreground-muted); line-height:1.45 }
  .fleet-live__task-prefix { font-family:var(--font-mono); font-size:10px;
    text-transform:lowercase; letter-spacing:0.06em;
    color:var(--c); margin-right:8px; font-weight:600 }
  .fleet-live__task code { font-family:var(--font-mono); font-size:11px;
    background:var(--color-surface-2); padding:1px 5px; border-radius:3px;
    border:1px solid var(--color-border-subtle);
    color:var(--color-brand-glow, var(--color-foreground)) }

  /* Progress block */
  .fleet-live__progress { display:flex; flex-direction:column; gap:5px; min-width:0 }
  .fleet-live__progress-row { display:flex; justify-content:space-between;
    font-family:var(--font-mono); font-size:9.5px; letter-spacing:0.04em;
    color:var(--color-foreground-faint); }
  .fleet-live__bar { height:2px; background:var(--color-border-subtle); position:relative;
    border-radius:1px; overflow:hidden }
  .fleet-live__bar-fill { position:absolute; left:0; top:0; bottom:0;
    background:var(--c); width:var(--p, 40%) }
  .fleet-live__progress.is-indeterminate .fleet-live__bar-fill { width:30%;
    animation:fleet-live-ind 1.6s linear infinite }
  @keyframes fleet-live-ind { 0%{transform:translateX(-100%)} 100%{transform:translateX(330%)} }
  .fleet-live__progress.is-stuck .fleet-live__bar { background:repeating-linear-gradient(
    90deg, var(--color-error) 0 4px, transparent 4px 8px); }
  .fleet-live__progress.is-stuck .fleet-live__bar-fill { display:none }

  /* Action buttons on the row */
  .fleet-live__actions { display:flex; gap:6px; align-items:center }
  .fleet-live__btn { font-family:var(--font-mono); font-size:10.5px; font-weight:500;
    height:24px; padding:0 10px; cursor:pointer;
    background:transparent; color:var(--color-foreground-muted);
    border:1px solid var(--color-border); border-radius:4px;
    transition:color 120ms, background 120ms, border-color 120ms }
  .fleet-live__btn:hover { color:var(--color-foreground); border-color:#2f2f38;
    background:var(--color-surface-2) }
  .fleet-live__btn--go { background:var(--color-brand-soft); color:var(--color-brand);
    border-color:var(--color-brand-border) }
  .fleet-live__btn--go:hover { background:var(--color-brand-soft);
    color:var(--color-brand-glow, var(--color-brand)); border-color:var(--color-brand) }
  .fleet-live__btn--danger:hover { color:var(--color-error);
    border-color:var(--color-error-border) }

  /* Right rail — flat chat panel. No phone frame. */
  .fleet-live__rail { background:var(--color-surface-1);
    display:flex; flex-direction:column; min-height:0; overflow:hidden }
  .fleet-live__rail-head { padding:12px 16px;
    border-bottom:1px solid var(--color-border-subtle);
    display:flex; align-items:center; gap:10px;
    font-family:var(--font-mono); font-size:10px; font-weight:600;
    text-transform:uppercase; letter-spacing:0.12em;
    color:var(--color-foreground); }
  .fleet-live__rail-head-title { color:var(--color-foreground) }
  .fleet-live__rail-head-meta { margin-left:auto; color:var(--color-foreground-faint);
    font-weight:400; letter-spacing:0.02em; text-transform:none; font-size:10.5px;
    font-family:var(--font-mono) }
  .fleet-live__rail-status { width:6px; height:6px; border-radius:50%;
    background:var(--color-success) }

  .fleet-live__msgs { flex:1; overflow-y:auto; padding:12px 14px;
    display:flex; flex-direction:column; gap:8px }
  .fleet-live__msgs-empty { color:var(--color-foreground-faint); font-style:italic;
    font-size:11.5px; text-align:center; padding:24px 0 }
  .fleet-live__msg { max-width:88%; padding:8px 11px; font-size:12.5px;
    line-height:1.45; border-radius:6px;
    border:1px solid var(--color-border-subtle); white-space:pre-wrap; word-break:break-word }
  .fleet-live__msg--shelly { align-self:flex-start; background:var(--color-surface-2);
    color:var(--color-foreground); border-bottom-left-radius:2px }
  .fleet-live__msg--user { align-self:flex-end; background:var(--color-brand-soft);
    border-color:var(--color-brand-border); color:var(--color-foreground);
    border-bottom-right-radius:2px }
  .fleet-live__msg-ts { font-family:var(--font-mono); font-size:9px;
    color:var(--color-foreground-faint); margin-top:4px; letter-spacing:0.04em }

  .fleet-live__compose { padding:10px 12px; border-top:1px solid var(--color-border-subtle);
    background:var(--color-surface-1); display:flex; gap:8px; align-items:center }
  .fleet-live__compose input { flex:1; height:30px; padding:0 10px;
    background:var(--color-surface-2); border:1px solid var(--color-border-subtle);
    border-radius:6px; color:var(--color-foreground);
    font-family:var(--font-sans); font-size:12.5px; outline:none;
    transition:border-color 120ms }
  .fleet-live__compose input:focus { border-color:var(--color-brand) }
  .fleet-live__compose input::placeholder { color:var(--color-foreground-faint) }
  .fleet-live__compose button { height:30px; padding:0 12px;
    background:var(--color-brand); color:var(--color-brand-foreground);
    border:none; border-radius:6px; cursor:pointer;
    font-family:var(--font-sans); font-weight:600; font-size:12px;
    transition:background 120ms }
  .fleet-live__compose button:hover { background:var(--color-brand-glow,var(--color-brand)) }
  .fleet-live__compose button:disabled { opacity:0.4; cursor:not-allowed }
`;

function statusTone(status) {
  switch (status) {
    case 'running':           return ['var(--color-warning)', 'var(--color-warning-soft)', 'var(--color-warning-border)'];
    case 'awaiting_approval': return ['var(--color-warning)', 'var(--color-warning-soft)', 'var(--color-warning-border)'];
    case 'awaiting_input':    return ['var(--color-error)',   'var(--color-error-soft)',   'var(--color-error-border)'];
    case 'blocked':
    case 'exhausted':         return ['var(--color-error)',   'var(--color-error-soft)',   'var(--color-error-border)'];
    case 'done':
    case 'completed':         return ['var(--color-success)', 'var(--color-success-soft)', 'var(--color-success-border)'];
    case 'cancelled':         return ['var(--color-foreground-faint)', 'var(--color-surface-2)', 'var(--color-border)'];
    default:                  return ['var(--color-info)',    'var(--color-info-soft)',    'var(--color-info-border)'];
  }
}

function statusVerb(status) {
  switch (status) {
    case 'running':           return 'now';
    case 'awaiting_approval': return 'awaiting';
    case 'awaiting_input':    return 'asking';
    case 'blocked':           return 'stuck';
    case 'exhausted':         return 'exhausted';
    case 'done':
    case 'completed':         return 'done';
    case 'cancelled':         return 'cancelled';
    default:                  return status;
  }
}

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r > 0 ? `${m}m ${String(r).padStart(2, '0')}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtTokens(n) {
  if (n == null || n === 0) return '—';
  if (n < 1000) return `${n}`;
  if (n < 1000000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}

function fmtMoney(usd) {
  if (usd == null || usd === 0) return '—';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function NarrativeText({ text }) {
  if (!text) return null;
  const parts = String(text).split(/(`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    return <span key={i}>{part}</span>;
  });
}

function actionsForStatus(status) {
  switch (status) {
    case 'running':           return [{ label: 'Tail' }, { label: 'Kill', kind: 'danger' }];
    case 'awaiting_approval': return [{ label: 'Approve', kind: 'go' }, { label: 'Tail' }];
    case 'awaiting_input':    return [{ label: 'Reply', kind: 'go' }, { label: 'Cancel', kind: 'danger' }];
    case 'blocked':
    case 'exhausted':         return [{ label: 'Retry', kind: 'go' }, { label: 'Inspect' }];
    case 'done':
    case 'completed':         return [{ label: 'Inspect' }];
    case 'cancelled':         return [{ label: 'Retry' }];
    default:                  return [{ label: 'Inspect' }];
  }
}

function Row({ row, onAction }) {
  const [c, cSoft, cBorder] = statusTone(row.status);
  const stepCount = row.last_step_index || 1;
  const totalSteps = row.total_steps || null;
  const stepLabel = totalSteps ? `step ${stepCount} of ${totalSteps}` : `step ${stepCount} of ?`;
  const indeterminate = !totalSteps && row.status === 'running';
  const stuck = row.status === 'awaiting_input' || row.status === 'blocked';
  const progPct = totalSteps ? Math.round((stepCount / totalSteps) * 100) : 40;

  const narrative = row.last_step_narrative
    || (row.last_step_status ? `${row.current_step} — ${row.last_step_status}` : row.current_step)
    || '(idle)';

  return (
    <div className="fleet-live__row" style={{ '--c': c, '--c-soft': cSoft, '--c-border': cBorder }}>
      <div className="fleet-live__badge">{row.agent || row.current_step || row.workflow}</div>

      <div style={{ minWidth: 0 }}>
        <div className="fleet-live__title-line">
          <span className="fleet-live__title">
            {row.identifier || (row.title ? row.title.slice(0, 60) : row.work_item_id?.slice(0, 12))}
          </span>
          <span className="fleet-live__ref">
            {row.last_job_id ? `job ${String(row.last_job_id).slice(0, 4)}` : ''}
            {row.project_name ? ` · ${row.project_name}` : ''}
          </span>
        </div>
        <div className="fleet-live__task">
          <span className="fleet-live__task-prefix">{statusVerb(row.status)} ›</span>
          <NarrativeText text={narrative} />
        </div>
      </div>

      <div className={`fleet-live__progress ${indeterminate ? 'is-indeterminate' : ''} ${stuck ? 'is-stuck' : ''}`}>
        <div className="fleet-live__progress-row">
          <span>{stepLabel}</span>
          <span>{fmtDuration(row.last_step_duration_ms || (row.last_event_at && Date.now() - Number(row.last_event_at)))}</span>
        </div>
        <div className="fleet-live__bar"><div className="fleet-live__bar-fill" style={{ '--p': `${progPct}%` }} /></div>
        <div className="fleet-live__progress-row">
          <span>{fmtTokens(row.tokens_used)} {row.tokens_used ? 'tok' : ''}</span>
          <span>{fmtMoney(row.spend_usd)}</span>
        </div>
      </div>

      <div className="fleet-live__actions">
        {actionsForStatus(row.status).map(b => (
          <button
            key={b.label}
            className={`fleet-live__btn ${b.kind === 'go' ? 'fleet-live__btn--go' : ''} ${b.kind === 'danger' ? 'fleet-live__btn--danger' : ''}`}
            onClick={(e) => { e.stopPropagation(); onAction(b.label.toLowerCase(), row); }}
          >{b.label}</button>
        ))}
      </div>
    </div>
  );
}

function ChatPanel({ apiUrl, apiKey }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  const load = async () => {
    if (!apiKey) return;
    try {
      const r = await fetch(`${apiUrl}/api/transcript/recent?minutes=240&limit=30`, {
        headers: { 'X-API-Key': apiKey },
      });
      if (!r.ok) return;
      const d = await r.json();
      setMessages(Array.isArray(d.messages) ? d.messages : []);
    } catch { /* non-fatal */ }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [apiKey]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await fetch(`${apiUrl}/api/threads/general/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ content: text, role: 'user' }),
      });
      if (r.ok) { setDraft(''); await load(); }
    } finally {
      setSending(false);
    }
  }

  function fmtTs(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  return (
    <aside className="fleet-live__rail">
      <div className="fleet-live__rail-head">
        <span className="fleet-live__rail-status" />
        <span className="fleet-live__rail-head-title">Shelly</span>
        <span className="fleet-live__rail-head-meta">{messages.length ? `${messages.length} msgs · live` : 'live'}</span>
      </div>
      <div className="fleet-live__msgs" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="fleet-live__msgs-empty">No recent messages</div>
        )}
        {messages.map(m => (
          <div
            key={m.id || `${m.created_at}-${m.direction}`}
            className={`fleet-live__msg ${m.direction === 'out' ? 'fleet-live__msg--shelly' : 'fleet-live__msg--user'}`}
          >
            {m.content}
            <div className="fleet-live__msg-ts">{fmtTs(m.created_at)}</div>
          </div>
        ))}
      </div>
      <div className="fleet-live__compose">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Reply to Shelly…"
          disabled={sending}
        />
        <button onClick={send} disabled={sending || !draft.trim()}>Send</button>
      </div>
    </aside>
  );
}

function TopStrip({ projectName, sseConnected }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="fleet-live__top">
      <span className="fleet-live__top-title">Fleet · live</span>
      <span className="fleet-live__top-pad" />
      <span>{now.toTimeString().slice(0, 8)}</span>
      <span>·</span>
      <span>{projectName || 'studio'}</span>
      <span>·</span>
      <span>
        <span
          className="fleet-live__dot"
          style={{ background: sseConnected ? 'var(--color-success)' : 'var(--color-error)' }}
        />
        {sseConnected ? 'connected' : 'offline'}
      </span>
    </div>
  );
}

const FILTERS = [
  { id: 'running', label: 'running', match: (r) => r.status === 'running' },
  { id: 'queued',  label: 'queued',  match: (r) => r.status === 'awaiting_approval' || r.status === 'awaiting_input' },
  { id: 'stuck',   label: 'stuck',   match: (r) => ['blocked', 'exhausted', 'awaiting_input'].includes(r.status) },
  { id: 'recent',  label: 'recent',  match: () => true },
  { id: 'all',     label: 'all',     match: () => true },
];

export function FleetLiveView({ apiUrl, apiKey, sseConnected = false, projectName }) {
  const [agents, setAgents] = useState([]);
  const [filter, setFilter] = useState('running');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!apiKey) return;
    try {
      const status = filter === 'recent' || filter === 'all' ? 'all' : 'active';
      const r = await fetch(`${apiUrl}/api/fleet?status=${status}`, {
        headers: { 'X-API-Key': apiKey },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setAgents(Array.isArray(d.agents) ? d.agents : []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [apiKey, filter]);

  const filtered = useMemo(() => {
    const f = FILTERS.find(x => x.id === filter) || FILTERS[FILTERS.length - 1];
    return agents.filter(f.match);
  }, [agents, filter]);

  const totals = useMemo(() => ({
    running: agents.filter(a => a.status === 'running').length,
    queued:  agents.filter(a => a.status === 'awaiting_approval' || a.status === 'awaiting_input').length,
    stuck:   agents.filter(a => ['blocked', 'exhausted'].includes(a.status)).length,
    done:    agents.filter(a => a.status === 'done' || a.status === 'completed').length,
    tokens24h: agents.reduce((sum, a) => sum + (a.tokens_used || 0), 0),
  }), [agents]);

  async function handleAction(action, row) {
    if (!apiKey || !row.instance_id) return;
    const map = {
      kill: 'cancel', cancel: 'cancel', approve: 'approve', retry: 'retry',
      reply: null, tail: null, inspect: null, pause: null,
    };
    const endpoint = map[action];
    if (!endpoint) return;
    try {
      const r = await fetch(`${apiUrl}/api/fleet/${row.instance_id}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      });
      if (r.ok) load();
    } catch { /* non-fatal */ }
  }

  return (
    <>
      <style>{STYLES}</style>
      <div className="fleet-live">
        <TopStrip projectName={projectName} sseConnected={sseConnected} />

        <div className="fleet-live__grid">
          <div className="fleet-live__main">
            <div className="fleet-live__header">
              <h1 className="fleet-live__h1">Fleet</h1>
              <span className="fleet-live__meta">
                {agents.length} agents · {totals.running} active · {totals.queued} queued
              </span>
              <span className="fleet-live__pad" />
              {FILTERS.map(f => (
                <button
                  key={f.id}
                  className={`fleet-live__chip ${filter === f.id ? 'is-active' : ''}`}
                  onClick={() => setFilter(f.id)}
                >{f.label}</button>
              ))}
            </div>

            <div className="fleet-live__totals">
              <div className="fleet-live__cell" style={{ '--c': 'var(--color-warning)' }}>
                <span className="fleet-live__cell-n">{totals.running}</span>
                <span className="fleet-live__cell-l">running</span>
              </div>
              <div className="fleet-live__cell" style={{ '--c': 'var(--color-warning)' }}>
                <span className="fleet-live__cell-n">{totals.queued}</span>
                <span className="fleet-live__cell-l">queued</span>
              </div>
              <div className="fleet-live__cell" style={{ '--c': 'var(--color-error)' }}>
                <span className="fleet-live__cell-n">{totals.stuck}</span>
                <span className="fleet-live__cell-l">stuck</span>
              </div>
              <div className="fleet-live__cell" style={{ '--c': 'var(--color-success)' }}>
                <span className="fleet-live__cell-n">{totals.done}</span>
                <span className="fleet-live__cell-l">done · today</span>
              </div>
              <div className="fleet-live__cell" style={{ '--c': 'var(--color-foreground-muted)' }}>
                <span className="fleet-live__cell-n">{totals.tokens24h ? fmtTokens(totals.tokens24h) : '—'}</span>
                <span className="fleet-live__cell-l">tokens · 24h</span>
              </div>
            </div>

            <div className="fleet-live__stream">
              {loading && <div className="fleet-live__empty">Loading…</div>}
              {!loading && error && (
                <div className="fleet-live__empty" style={{ color: 'var(--color-error)' }}>
                  Error: {error}
                </div>
              )}
              {!loading && !error && filtered.length === 0 && (
                <div className="fleet-live__empty">No agents matching <em>{filter}</em>.</div>
              )}
              {!loading && !error && filtered.map(row => (
                <Row key={row.instance_id} row={row} onAction={handleAction} />
              ))}
            </div>
          </div>

          <ChatPanel apiUrl={apiUrl} apiKey={apiKey} />
        </div>
      </div>
    </>
  );
}
