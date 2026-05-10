// src/dashboard/views/fleet-live-view.jsx
//
// Scriptorium-styled fleet view per Claude Design handoff bundle:
// devpanel-design-system/project/ui_kits/dashboard/fleet-live.html.
// Inline tokens (ink + parch + brass + Fraunces) — does NOT touch global
// CSS so the legacy fleet view (`/dashboard/fleet`) keeps its dark/indigo
// look. We're A/B'ing surfaces during the redesign.
//
// What's new vs the existing fleet view (the design's *features*, not
// just the visuals):
//   - Per-agent live progress: step number, duration, token count, spend.
//   - Indeterminate animated bar when step count is unknown.
//   - State-aware row-level action verbs (Tail / Kill / Approve / Pause /
//     Stop / Reject) — directly on the row, not buried in a detail rail.
//   - Striped progress bar when status === 'awaiting_input' to make
//     "needs you" visually distinct from "running".
//   - Filter chips (running / queued / stuck / recent / all) with brass
//     underline on the active one.
//   - Italic narrative task line with `now ›` / `retry N ›` / `stuck ›`
//     prefix and inline mono-code chips for symbol references.
//   - Telegram phone mirror in the right rail — the last few messages
//     between Shelly and Franck, plus a quick-reply input that POSTs to
//     /api/threads/general/messages so the dashboard can talk to her
//     without context-switching to Telegram.
//   - Top strip: clock + drift indicator + connection dot.
//   - 5-cell totals strip: running / queued / stuck / done-today /
//     tokens-24h.
import { useEffect, useMemo, useRef, useState } from 'react';

const TOKENS = `
  /* Scriptorium palette — ink + parch + brass. Scoped under
     .fleet-live so it doesn't bleed into the rest of the dashboard. */
  .fleet-live {
    --ink:#0e0a08; --tar:#1a120c; --pitch:#241914; --char:#2e211a;
    --parch:#f5e9d0; --parch-dim:#c4b39a; --parch-faint:#a8927a;
    --parch-mute:#7a6a55; --parch-deep:#5a4d3e;
    --brass:#c8a052; --gilt:#e8c074; --bronze:#7a5e2a;
    --good:#7fb069; --warn:#e8a838; --err:#e26d6d; --ash:#a89881;
    --hair:#3a2a1e; --edge:#4a3525; --quill:#6b4d36;
    --sans:'Fraunces',serif; --mono:'JetBrains Mono',ui-monospace,monospace;
    background:var(--ink); color:var(--parch);
    font-family:var(--sans);
    -webkit-font-smoothing:antialiased;
    display:flex; flex-direction:column;
    height:100%; overflow:hidden;
  }
  .fleet-live * { box-sizing:border-box }
  .fleet-live .top { display:flex; align-items:center; gap:14px; height:46px; padding:0 18px;
    background:var(--tar); border-bottom:1px solid var(--hair); flex-shrink:0;
    font-family:var(--mono); font-size:11.5px; color:var(--parch-dim) }
  .fleet-live .top .logo { font-family:var(--sans); font-weight:600; font-size:15px;
    color:var(--parch); font-feature-settings:'ss01' }
  .fleet-live .top .pad { flex:1 }
  .fleet-live .grid { flex:1; display:grid; grid-template-columns:1fr 380px; min-height:0 }
  .fleet-live .left { display:flex; flex-direction:column; min-height:0; border-right:1px solid var(--hair) }
  .fleet-live .head { padding:18px 22px; border-bottom:1px solid var(--hair);
    display:flex; align-items:baseline; gap:14px }
  .fleet-live .head h1 { margin:0; font-family:var(--sans); font-weight:500; font-size:22px;
    letter-spacing:-0.02em; color:var(--parch); font-feature-settings:'ss01' }
  .fleet-live .head .meta { font-family:var(--mono); font-size:11px; color:var(--parch-faint);
    letter-spacing:0.04em }
  .fleet-live .head .pad { flex:1 }
  .fleet-live .filt { font-family:var(--sans); font-style:italic; font-size:13.5px;
    color:var(--parch-dim); padding:4px 12px; cursor:pointer; background:none; border:none }
  .fleet-live .filt.on { color:var(--parch); text-decoration:underline;
    text-decoration-color:var(--brass); text-decoration-thickness:2px; text-underline-offset:5px }
  .fleet-live .filt:hover { color:var(--parch) }
  .fleet-live .totals { display:flex; gap:0; padding:14px 22px;
    border-bottom:1px solid var(--hair); background:var(--tar) }
  .fleet-live .tot { flex:1; display:flex; flex-direction:column; gap:4px;
    border-right:1px solid var(--hair); padding-right:18px; margin-right:18px }
  .fleet-live .tot:last-child { border-right:none; margin-right:0; padding-right:0 }
  .fleet-live .tot .n { font-family:var(--sans); font-weight:500; font-size:30px;
    color:var(--c, var(--parch));
    font-feature-settings:'tnum','ss01';
    font-variant-numeric:tabular-nums oldstyle-nums;
    line-height:1; letter-spacing:-0.02em }
  .fleet-live .tot .l { font-family:var(--mono); font-size:10px; color:var(--parch-mute);
    text-transform:uppercase; letter-spacing:0.14em; font-weight:500 }
  .fleet-live .stream { flex:1; overflow-y:auto; padding:0 }
  .fleet-live .ag { display:grid;
    grid-template-columns:64px 1fr 200px 80px;
    gap:18px; padding:18px 22px;
    border-bottom:1px solid var(--hair);
    align-items:center; cursor:default }
  .fleet-live .ag:hover { background:var(--tar) }
  .fleet-live .ag .badge { font-family:var(--mono); font-size:9.5px; font-weight:600;
    text-transform:uppercase; letter-spacing:0.14em;
    color:var(--c); padding:5px 0;
    border-top:2px solid var(--c); border-bottom:2px solid var(--c);
    text-align:center }
  .fleet-live .ag .body .name { font-family:var(--sans); font-weight:500; font-size:16px;
    color:var(--parch); letter-spacing:-0.005em; font-feature-settings:'ss01';
    line-height:1.2; margin-bottom:4px;
    display:flex; align-items:baseline; gap:10px }
  .fleet-live .ag .body .ref { font-family:var(--mono); font-size:10.5px;
    color:var(--parch-mute); letter-spacing:0.04em }
  .fleet-live .ag .body .task { font-family:var(--sans); font-style:italic; font-size:13.5px;
    color:var(--parch-dim); line-height:1.5 }
  .fleet-live .ag .body .task .now { color:var(--gilt); font-style:normal;
    font-family:var(--mono); font-size:11px; letter-spacing:0.04em; margin-right:6px }
  .fleet-live .ag .body .task code { font-family:var(--mono); font-size:11.5px;
    background:var(--ink); padding:1px 6px; border:1px solid var(--hair);
    color:var(--gilt) }
  .fleet-live .ag .prog { display:flex; flex-direction:column; gap:7px }
  .fleet-live .ag .prog .bar { height:3px; background:var(--ink); position:relative;
    border-top:1px solid var(--hair); border-bottom:1px solid var(--hair) }
  .fleet-live .ag .prog .bar i { position:absolute; left:0; top:0; bottom:0;
    background:var(--c); box-shadow:0 0 10px var(--c); width:var(--p, 40%) }
  .fleet-live .ag .prog.ind .bar i { width:30%; animation:fleet-live-ind 1.6s linear infinite }
  @keyframes fleet-live-ind { 0%{transform:translateX(-100%)} 100%{transform:translateX(330%)} }
  .fleet-live .ag .prog.stuck .bar { background:repeating-linear-gradient(90deg,var(--err),var(--err) 4px,transparent 4px,transparent 8px) }
  .fleet-live .ag .prog.stuck .bar i { display:none }
  .fleet-live .ag .prog .row { display:flex; justify-content:space-between;
    font-family:var(--mono); font-size:10px; color:var(--parch-faint); letter-spacing:0.04em }
  .fleet-live .ag .react { display:flex; flex-direction:column; gap:4px; align-items:flex-end }
  .fleet-live .ag .react button { font-family:var(--mono); font-size:10px; font-weight:600;
    text-transform:uppercase; letter-spacing:0.12em; padding:5px 10px;
    background:transparent; border:1px solid var(--edge); color:var(--parch-dim);
    cursor:pointer; width:74px }
  .fleet-live .ag .react button:hover { border-color:var(--brass); color:var(--brass) }
  .fleet-live .ag .react button.danger:hover { border-color:var(--err); color:var(--err) }
  .fleet-live .ag .react button.go { background:var(--brass); color:var(--ink); border-color:var(--brass) }
  .fleet-live .ag .react button.go:hover { background:var(--gilt); border-color:var(--gilt); color:var(--ink) }
  .fleet-live .empty { padding:40px 22px; text-align:center; color:var(--parch-mute);
    font-style:italic; font-size:14px }
  .fleet-live .rail { background:var(--tar); display:flex; flex-direction:column; min-height:0 }
  .fleet-live .rail-head { padding:14px 18px; border-bottom:1px solid var(--hair);
    display:flex; align-items:center; gap:10px; font-family:var(--mono);
    font-size:10.5px; font-weight:600; text-transform:uppercase;
    letter-spacing:0.16em; color:var(--parch) }
  .fleet-live .rail-head::before { content:""; width:7px; height:7px; border-radius:50%;
    background:var(--good); box-shadow:0 0 10px var(--good) }
  .fleet-live .rail-head .ct { margin-left:auto; color:var(--parch-mute);
    font-weight:500; letter-spacing:0.04em; text-transform:none }
  .fleet-live .phone-wrap { flex:1; display:flex; align-items:center; justify-content:center;
    padding:14px; overflow:hidden }
  .fleet-live .phone { width:280px; height:520px; background:var(--ink);
    border:8px solid #1a120c; border-radius:32px;
    box-shadow:0 30px 60px rgba(0,0,0,.7),0 0 0 1px rgba(245,233,208,.04) inset,0 0 60px rgba(200,160,82,.05);
    display:flex; flex-direction:column; overflow:hidden; position:relative }
  .fleet-live .phone::before { content:""; position:absolute; top:6px; left:50%;
    transform:translateX(-50%); width:80px; height:6px; background:#0e0a08;
    border-radius:6px; z-index:5 }
  .fleet-live .ph-top { height:38px; display:flex; align-items:center; gap:8px;
    padding:0 14px; background:#241914; border-bottom:1px solid var(--hair);
    padding-top:8px }
  .fleet-live .ph-top .av { width:24px; height:24px; border-radius:50%;
    background:linear-gradient(155deg,var(--brass),var(--bronze));
    display:flex; align-items:center; justify-content:center;
    color:var(--ink); font-family:var(--sans); font-weight:600; font-size:12px }
  .fleet-live .ph-top .who { font-family:var(--sans); font-weight:500; font-size:13px;
    color:var(--parch); line-height:1 }
  .fleet-live .ph-top .sub { font-family:var(--mono); font-size:9px; color:var(--good);
    margin-top:2px; display:inline-flex; align-items:center; gap:4px }
  .fleet-live .ph-top .sub::before { content:""; width:5px; height:5px;
    border-radius:50%; background:var(--good) }
  .fleet-live .ph-msgs { flex:1; overflow-y:auto; padding:14px 12px; display:flex;
    flex-direction:column; gap:8px; background:var(--ink) }
  .fleet-live .pm { max-width:78%; padding:8px 11px; font-family:var(--sans); font-size:13px;
    line-height:1.4; color:var(--parch); border-radius:10px; white-space:pre-wrap }
  .fleet-live .pm.s { background:var(--tar); border:1px solid var(--hair);
    align-self:flex-start; border-bottom-left-radius:3px }
  .fleet-live .pm.m { background:var(--pitch); border:1px solid var(--edge);
    align-self:flex-end; border-bottom-right-radius:3px }
  .fleet-live .pm .ts { font-family:var(--mono); font-size:9px; color:var(--parch-mute);
    margin-top:4px; letter-spacing:0.04em }
  .fleet-live .ph-input { padding:10px 12px; border-top:1px solid var(--hair);
    background:var(--tar); display:flex; gap:8px; align-items:center }
  .fleet-live .ph-input input { flex:1; height:30px; background:var(--ink);
    border:1px solid var(--edge); padding:0 10px; font-family:var(--sans);
    font-size:12px; color:var(--parch); outline:none }
  .fleet-live .ph-input input::placeholder { color:var(--parch-faint); font-style:italic }
  .fleet-live .ph-input input:focus { border-color:var(--brass) }
  .fleet-live .ph-input button { width:30px; height:30px; background:var(--brass);
    color:var(--ink); border:none; cursor:pointer; font-family:var(--mono); font-size:14px;
    font-weight:600; display:flex; align-items:center; justify-content:center }
  .fleet-live .ph-input button:hover { background:var(--gilt) }
  .fleet-live .ph-input button:disabled { opacity:0.4; cursor:not-allowed }
`;

// Map the workflow_instance.status to a row tone variable. Returns the
// CSS variable name (without var() wrapping) so callers can plug it into
// inline styles cleanly.
function statusTone(status) {
  switch (status) {
    case 'running': return 'var(--warn)'; // active = warm
    case 'awaiting_approval': return 'var(--brass)';
    case 'awaiting_input': return 'var(--err)'; // needs you
    case 'blocked':
    case 'exhausted': return 'var(--err)';
    case 'done':
    case 'completed': return 'var(--good)';
    case 'cancelled': return 'var(--ash)';
    default: return 'var(--ash)';
  }
}

function statusVerb(status) {
  switch (status) {
    case 'running': return 'now';
    case 'awaiting_approval': return 'await';
    case 'awaiting_input': return 'asking';
    case 'blocked': return 'stuck';
    case 'exhausted': return 'exhausted';
    case 'done':
    case 'completed': return 'done';
    case 'cancelled': return 'cancelled';
    default: return status;
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

function fmtAge(timestamp) {
  if (!timestamp) return '—';
  const ms = Date.now() - Number(timestamp);
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function fmtTokens(n) {
  if (n == null || n === 0) return '—';
  if (n < 1000) return `${n} tok`;
  if (n < 1000000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k tok`;
  return `${(n / 1000000).toFixed(2)}M tok`;
}

function fmtMoney(usd) {
  if (usd == null || usd === 0) return '—';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

// React-flavored mini-renderer for the task narrative — recognise
// `[`backticks`]` as inline code chips so symbol names visually pop the
// way the design intends.
function NarrativeText({ text }) {
  if (!text) return null;
  const parts = String(text).split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code key={i}>{part.slice(1, -1)}</code>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function ActionButtons({ row, onAction }) {
  const buttons = [];
  switch (row.status) {
    case 'running':
      buttons.push({ label: 'Tail', kind: '' });
      buttons.push({ label: 'Kill', kind: 'danger' });
      break;
    case 'awaiting_approval':
      buttons.push({ label: 'Approve', kind: 'go' });
      buttons.push({ label: 'Tail', kind: '' });
      break;
    case 'awaiting_input':
      buttons.push({ label: 'Reply', kind: 'go' });
      buttons.push({ label: 'Cancel', kind: 'danger' });
      break;
    case 'blocked':
    case 'exhausted':
      buttons.push({ label: 'Retry', kind: 'go' });
      buttons.push({ label: 'Inspect', kind: '' });
      break;
    case 'done':
    case 'completed':
      buttons.push({ label: 'Inspect', kind: '' });
      break;
    case 'cancelled':
      buttons.push({ label: 'Retry', kind: '' });
      break;
    default:
      buttons.push({ label: 'Inspect', kind: '' });
  }
  return (
    <div className="react">
      {buttons.map(b => (
        <button
          key={b.label}
          className={b.kind}
          onClick={(e) => { e.stopPropagation(); onAction(b.label.toLowerCase(), row); }}
        >{b.label}</button>
      ))}
    </div>
  );
}

function Row({ row, onAction }) {
  const tone = statusTone(row.status);
  const verb = statusVerb(row.status);
  const stepCount = row.last_step_index || 1;
  const totalSteps = row.total_steps || null;
  const stepLabel = totalSteps ? `step ${stepCount} of ${totalSteps}` : `step ${stepCount} of ?`;
  const indeterminate = !totalSteps && row.status === 'running';
  const stuck = row.status === 'awaiting_input' || row.status === 'blocked';
  const progPct = totalSteps ? Math.round((stepCount / totalSteps) * 100) : 40;

  // Narrative: prefer a parsed last-event description if the API provides it,
  // otherwise fall back to current_step + last_step_status.
  const narrative = row.last_step_narrative
    || (row.last_step_status ? `${row.current_step} — ${row.last_step_status}` : row.current_step)
    || '(idle)';

  return (
    <div className="ag" style={{ '--c': tone }}>
      <div className="badge">{row.agent || row.current_step || row.workflow}</div>
      <div className="body">
        <div className="name">
          <span>{row.identifier || (row.title ? row.title.slice(0, 60) : row.work_item_id?.slice(0, 12))}</span>
          <span className="ref">
            {row.last_job_id ? `job ${String(row.last_job_id).slice(0, 4)}` : ''}
            {row.project_name ? ` · ${row.project_name}` : ''}
          </span>
        </div>
        <div className="task">
          <span className="now">{verb} ›</span>
          <NarrativeText text={narrative} />
        </div>
      </div>
      <div className={`prog ${indeterminate ? 'ind' : ''} ${stuck ? 'stuck' : ''}`}>
        <div className="row">
          <span>{stepLabel}</span>
          <span>{fmtDuration(row.last_step_duration_ms || (row.last_event_at && Date.now() - Number(row.last_event_at)))}</span>
        </div>
        <div className="bar" style={{ '--p': `${progPct}%` }}><i /></div>
        <div className="row">
          <span>{fmtTokens(row.tokens_used)}</span>
          <span>{fmtMoney(row.spend_usd)}</span>
        </div>
      </div>
      <ActionButtons row={row} onAction={onAction} />
    </div>
  );
}

function PhoneMirror({ apiUrl, apiKey }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  const load = async () => {
    if (!apiKey) return;
    try {
      const r = await fetch(`${apiUrl}/api/transcript/recent?minutes=240&limit=12`, {
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
      if (r.ok) {
        setDraft('');
        await load();
      }
    } finally {
      setSending(false);
    }
  }

  function fmtTs(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  return (
    <div className="phone">
      <div className="ph-top">
        <div className="av">S</div>
        <div>
          <div className="who">Shelly</div>
          <div className="sub">live mirror</div>
        </div>
      </div>
      <div className="ph-msgs" ref={scrollRef}>
        {messages.length === 0 && (
          <div style={{ color: 'var(--parch-mute)', fontStyle: 'italic', fontSize: 12, textAlign: 'center' }}>
            no recent messages
          </div>
        )}
        {messages.map(m => (
          <div key={m.id || `${m.created_at}-${m.direction}`} className={`pm ${m.direction === 'out' ? 's' : 'm'}`}>
            {m.content}
            <div className="ts">{fmtTs(m.created_at)}</div>
          </div>
        ))}
      </div>
      <div className="ph-input">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="reply to Shelly…"
          disabled={sending}
        />
        <button onClick={send} disabled={sending || !draft.trim()}>▸</button>
      </div>
    </div>
  );
}

function TopStrip({ projectName, sseConnected }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="top">
      <span className="logo">devpanl</span>
      <span style={{ color: 'var(--parch-faint)' }}>flight deck</span>·
      <b style={{ color: 'var(--parch)', fontWeight: 500, fontFamily: 'var(--sans)', fontSize: 13 }}>
        fleet · live
      </b>
      <span className="pad" />
      <span>
        {now.toTimeString().slice(0, 8)} ·
        {' '}
        {projectName || 'studio'} ·{' '}
        <span style={{ color: sseConnected ? 'var(--good)' : 'var(--err)' }}>●</span>{' '}
        {sseConnected ? 'connected' : 'offline'}
      </span>
    </div>
  );
}

const FILTERS = [
  { id: 'running', label: 'running', match: (r) => r.status === 'running' },
  { id: 'queued', label: 'queued', match: (r) => r.status === 'awaiting_approval' || r.status === 'awaiting_input' },
  { id: 'stuck', label: 'stuck', match: (r) => r.status === 'blocked' || r.status === 'exhausted' || r.status === 'awaiting_input' },
  { id: 'recent', label: 'recent', match: () => true /* all on recent endpoint */ },
  { id: 'all', label: 'all', match: () => true },
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
    const t = setInterval(load, 5000); // 5s poll — fleet changes are slow
    return () => clearInterval(t);
  }, [apiKey, filter]);

  const filtered = useMemo(() => {
    const f = FILTERS.find(x => x.id === filter) || FILTERS[FILTERS.length - 1];
    return agents.filter(f.match);
  }, [agents, filter]);

  const totals = useMemo(() => ({
    running: agents.filter(a => a.status === 'running').length,
    queued: agents.filter(a => a.status === 'awaiting_approval' || a.status === 'awaiting_input').length,
    stuck: agents.filter(a => ['blocked', 'exhausted'].includes(a.status)).length,
    done: agents.filter(a => a.status === 'done' || a.status === 'completed').length,
    tokens24h: agents.reduce((sum, a) => sum + (a.tokens_used || 0), 0),
  }), [agents]);

  async function handleAction(action, row) {
    if (!apiKey || !row.instance_id) return;
    // Map UI verb to fleet action endpoint. All hit /api/fleet/:id/<verb>;
    // verbs the existing routes-fleet.js already supports: cancel, approve, retry.
    // Tail/Reply/Inspect open a deep link — for now we just no-op visually
    // until those surfaces exist as drawer panels.
    const map = {
      kill: 'cancel',
      cancel: 'cancel',
      approve: 'approve',
      retry: 'retry',
      reply: null, // future: open the inbox composer
      tail: null,  // future: open events stream drawer
      inspect: null,
      pause: null,
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
      <style>{TOKENS}</style>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,500&family=JetBrains+Mono:wght@400;500;600&display=swap"
        rel="stylesheet"
      />
      <div className="fleet-live">
        <TopStrip projectName={projectName} sseConnected={sseConnected} />
        <div className="grid">
          <div className="left">
            <div className="head">
              <h1>Fleet</h1>
              <span className="meta">
                {agents.length} agents · {totals.running} active · {totals.queued} queued
              </span>
              <span className="pad" />
              {FILTERS.map(f => (
                <button
                  key={f.id}
                  className={`filt ${filter === f.id ? 'on' : ''}`}
                  onClick={() => setFilter(f.id)}
                >{f.label}</button>
              ))}
            </div>
            <div className="totals">
              <div className="tot" style={{ '--c': 'var(--gilt)' }}>
                <span className="n">{totals.running}</span>
                <span className="l">running</span>
              </div>
              <div className="tot" style={{ '--c': 'var(--warn)' }}>
                <span className="n">{totals.queued}</span>
                <span className="l">queued</span>
              </div>
              <div className="tot" style={{ '--c': 'var(--err)' }}>
                <span className="n">{totals.stuck}</span>
                <span className="l">stuck</span>
              </div>
              <div className="tot" style={{ '--c': 'var(--good)' }}>
                <span className="n">{totals.done}</span>
                <span className="l">done · today</span>
              </div>
              <div className="tot" style={{ '--c': 'var(--parch-faint)' }}>
                <span className="n">{totals.tokens24h ? fmtTokens(totals.tokens24h).replace(' tok', '') : '—'}</span>
                <span className="l">tokens · 24h</span>
              </div>
            </div>
            <div className="stream">
              {loading && <div className="empty">loading the scriptorium…</div>}
              {!loading && error && <div className="empty" style={{ color: 'var(--err)' }}>error: {error}</div>}
              {!loading && !error && filtered.length === 0 && (
                <div className="empty">no agents matching <em>{filter}</em>.</div>
              )}
              {!loading && !error && filtered.map(row => (
                <Row key={row.instance_id} row={row} onAction={handleAction} />
              ))}
            </div>
          </div>
          <aside className="rail">
            <div className="rail-head">
              <span>Telegram · Shelly</span>
              <span className="ct">live mirror</span>
            </div>
            <div className="phone-wrap">
              <PhoneMirror apiUrl={apiUrl} apiKey={apiKey} />
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
