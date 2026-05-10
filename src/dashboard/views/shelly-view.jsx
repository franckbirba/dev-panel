// src/dashboard/views/shelly-view.jsx
// Three-pane Shelly surface (per Claude Design wireframe):
//   - Presence header: avatar + "awake · N ephemerals · last restart" prose
//   - Thread: tmux pane log parsed into message-like blocks + inline event
//             capsules for [builder]/[reviewer]/etc. pipeline events
//   - Right rail: live running-ephemerals list, pulled from /api/fleet
// Raw terminal pane still available behind a "raw" toggle for debugging
// the harness when something is wedged below the prose level.
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { IconRefresh } from '@/components/icons';

const STATUS_POLL_MS = 10_000;
const LOG_POLL_MS    = 5_000;
const FLEET_POLL_MS  = 15_000;
const LOG_LINES      = 200;

function StatusPill({ status }) {
  let label = 'DOWN', tone = 'error';
  if (status?.healthy) { label = 'AWAKE'; tone = 'success'; }
  else if (status?.claude_running && !status?.bun_running) label = 'BUN DOWN';
  else if (!status?.claude_running && status?.bun_running) label = 'CLAUDE DOWN';
  return (
    <span className={`status-chip ${tone === 'success' ? 'success' : 'error'}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

function timeAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const s = Math.round(ms / 1000);
  if (s < 60)   return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60)   return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48)   return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ── Log parser ────────────────────────────────────────────────────────────
// Shelly's tmux pane mixes:
//   - Pipeline events from notifyJob(): "[builder] FAILED job_id=..."
//   - Inbound channel events: "[capture-new] project=..." or "[thread:capture/123]..."
//   - Daily digest: "[digest] ..."
//   - Self-echo lines: "[Shelly] [✅ Up] ..."
//   - Free assistant prose
// We recognise the bracketed forms as *events* (compact capsules), and treat
// any other non-empty, non-prompt line as either inbound (when it begins with
// a Telegram-style "<franck>" or similar prefix) or assistant prose.
const EVENT_RE = /^\[([a-z][\w-]*(?:\/[\w-]+)?)\]\s*(.*)$/i;
const ROLE_TONE = {
  builder:  'var(--color-warning)',
  reviewer: 'var(--color-success)',
  qa:       'var(--color-info)',
  designer: 'var(--color-brand-glow)',
  architect:'var(--color-brand)',
  pm:       'var(--color-foreground-muted)',
  deploy:   'var(--color-error)',
  digest:   'var(--color-foreground-muted)',
  shelly:   'var(--color-brand-glow)',
  // capture-* / thread:* default to brand
};

function parseLog(raw) {
  const cleaned = raw
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\r/g, '');
  const lines = cleaned.split('\n');
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, '');
    if (!trimmed) {
      if (current) { blocks.push(current); current = null; }
      continue;
    }
    const m = trimmed.match(EVENT_RE);
    if (m) {
      // Always flush any in-progress prose before recording an event.
      if (current) { blocks.push(current); current = null; }
      const tag = m[1].toLowerCase();
      blocks.push({ kind: 'event', tag, body: m[2] });
      continue;
    }
    // Coalesce consecutive prose lines into a single block — easier to read
    // than a forest of one-line bubbles.
    if (current && current.kind === 'prose') {
      current.body += '\n' + trimmed;
    } else {
      if (current) blocks.push(current);
      current = { kind: 'prose', body: trimmed };
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function EventCapsule({ tag, body }) {
  const role = tag.split(/[/\-]/)[0];
  const tone = ROLE_TONE[role] || 'var(--color-brand)';
  return (
    <div
      className="self-start inline-flex items-stretch border"
      style={{
        borderColor: tone,
        background: 'var(--color-background)',
        fontFamily: 'var(--font-mono)', fontSize: 11,
        maxWidth: '90%',
      }}
    >
      <span style={{ width: 3, background: tone, boxShadow: `0 0 8px ${tone}` }} />
      <span className="flex items-center gap-2 px-3 py-1.5">
        <span
          className="uppercase font-semibold"
          style={{ color: tone, letterSpacing: '0.12em', fontSize: 10 }}
        >
          {tag}
        </span>
        <span className="text-[var(--color-foreground-muted)] truncate" style={{ maxWidth: 600 }}>
          {body || '—'}
        </span>
      </span>
    </div>
  );
}

function ProseBlock({ body }) {
  return (
    <div
      className="self-start max-w-[80%] rounded-md px-3 py-2"
      style={{
        background: 'var(--color-surface-1)',
        border: '1px solid var(--color-border-subtle)',
        fontSize: 13.5, lineHeight: 1.5,
        color: 'var(--color-foreground)',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}
    >
      {body}
    </div>
  );
}

// ── Right rail ────────────────────────────────────────────────────────────
function EphemeralsRail({ apiUrl, apiKey }) {
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    if (!apiKey) return;
    try {
      const r = await fetch(`${apiUrl}/api/fleet?status=active`, {
        headers: { 'X-API-Key': apiKey },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setAgents(d.agents || []);
      setError(null);
    } catch (e) { setError(e.message); }
  }, [apiUrl, apiKey]);
  useEffect(() => {
    load();
    const id = setInterval(load, FLEET_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const running = agents.filter(a => a.status === 'running');
  const waiting = agents.filter(a => a.status === 'awaiting_approval');
  const blocked = agents.filter(a => ['blocked', 'exhausted'].includes(a.status));

  return (
    <aside className="shrink-0 flex flex-col" style={{ width: 300, borderLeft: '1px solid var(--color-border-subtle)', background: 'var(--color-surface-1)' }}>
      <div
        className="flex items-center gap-2.5 h-12 px-4 border-b border-[var(--color-border-subtle)] uppercase font-mono"
        style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.16em', color: 'var(--color-foreground)' }}
      >
        <span
          className="rounded-full"
          style={{
            width: 7, height: 7,
            background: running.length ? 'var(--color-warning)' : 'var(--color-foreground-faint)',
            boxShadow: running.length ? '0 0 10px var(--color-warning)' : 'none',
          }}
        />
        Running
        <span className="ml-auto" style={{ color: 'var(--color-foreground-faint)', fontWeight: 500, letterSpacing: '0.04em', textTransform: 'none' }}>
          {running.length} of {agents.length} active
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {error && <div className="px-4 py-3 text-[11px] text-[var(--color-error)]">Error: {error}</div>}
        {agents.length === 0 && !error && (
          <div className="px-4 py-8 text-center text-[11.5px] text-[var(--color-foreground-faint)]">
            No agents running. Shelly is just listening.
          </div>
        )}
        {[...running, ...waiting, ...blocked].map(a => {
          const tone = a.status === 'running' ? 'var(--color-brand-glow)'
            : a.status === 'awaiting_approval' ? 'var(--color-warning)'
            : 'var(--color-error)';
          return (
            <div key={a.instance_id} className="px-3 py-2.5 border-b border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-2)]" style={{ cursor: 'default' }}>
              <div className="flex items-center gap-2 mb-1">
                <span className="uppercase font-mono" style={{ color: tone, fontSize: 9.5, fontWeight: 600, letterSpacing: '0.12em' }}>
                  {a.agent || a.workflow}
                </span>
                <span className="text-[var(--color-foreground)]" style={{ fontSize: 12.5, fontWeight: 500 }}>
                  {a.identifier || a.work_item_id?.slice(0, 8) || '—'}
                </span>
                <span className="ml-auto font-mono text-[var(--color-foreground-faint)]" style={{ fontSize: 10 }}>
                  {a.last_job_id ? a.last_job_id.slice(0, 4) : ''}
                </span>
              </div>
              {a.current_step && (
                <div className="text-[var(--color-foreground-muted)] mb-2" style={{ fontSize: 11.5, lineHeight: 1.4, fontStyle: 'italic' }}>
                  {a.current_step}
                </div>
              )}
              <div className="font-mono text-[var(--color-foreground-faint)] flex items-center gap-2" style={{ fontSize: 9.5 }}>
                <span>{a.status}</span>
                <span>·</span>
                <span>{timeAgo(a.last_event_at)}</span>
                {a.project_name && <><span>·</span><span className="truncate">{a.project_name}</span></>}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// ── View ──────────────────────────────────────────────────────────────────
export function ShellyView({ apiUrl, apiKey }) {
  const [status, setStatus]       = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [log, setLog]             = useState('');
  const [logError, setLogError]   = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [rawMode, setRawMode]     = useState(false);
  const threadRef = useRef(null);
  const stickyBottomRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(`${apiUrl}/api/shelly/status`, { headers: { 'X-API-Key': apiKey } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus(await r.json());
      setStatusError(null);
    } catch (err) { setStatusError(err.message); }
  }, [apiUrl, apiKey]);

  const fetchLog = useCallback(async () => {
    try {
      const r = await fetch(`${apiUrl}/api/shelly/log?lines=${LOG_LINES}`, { headers: { 'X-API-Key': apiKey } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setLog(await r.text());
      setLogError(null);
    } catch (err) { setLogError(err.message); }
  }, [apiUrl, apiKey]);

  useEffect(() => {
    fetchStatus(); fetchLog();
    if (!autoRefresh) return;
    const sId = setInterval(fetchStatus, STATUS_POLL_MS);
    const lId = setInterval(fetchLog,    LOG_POLL_MS);
    return () => { clearInterval(sId); clearInterval(lId); };
  }, [autoRefresh, fetchStatus, fetchLog]);

  useEffect(() => {
    if (!threadRef.current || !stickyBottomRef.current) return;
    threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [log]);

  function onScroll() {
    if (!threadRef.current) return;
    const el = threadRef.current;
    stickyBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  const blocks = useMemo(() => parseLog(log), [log]);
  const cleanLog = useMemo(() => log
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\r/g, ''), [log]);

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex-1 flex flex-col min-w-0">
        {/* Presence header — single-row prose, not a metric grid. The 4-cell
            metric strip is gone; the data is folded into one humane line. */}
        <div className="flex items-center gap-3 px-5 h-14 border-b border-[var(--color-border-subtle)] shrink-0">
          <div
            className="rounded-full flex items-center justify-center shrink-0"
            style={{
              width: 36, height: 36,
              background: 'linear-gradient(155deg, var(--color-brand), var(--color-brand-foreground))',
              color: 'var(--color-brand-foreground)',
              fontWeight: 600, fontSize: 17,
              boxShadow: status?.healthy ? '0 0 16px var(--color-brand-soft)' : 'none',
            }}
          >
            S
          </div>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h1 className="text-[15px] font-semibold tracking-tight">Shelly</h1>
              {status && <StatusPill status={status} />}
            </div>
            <div className="font-mono text-[var(--color-foreground-faint)] truncate" style={{ fontSize: 11, marginTop: 2 }}>
              {status?.claude_running ? `claude pid ${status.claude_pid}` : 'claude offline'}
              {' · '}
              {status?.bun_running ? `bun pid ${status.bun_pid}` : 'bun offline'}
              {' · '}
              <span title={status?.last_restart_reason || ''}>
                last restart {timeAgo(status?.last_restart)}
              </span>
              {status?.restarts_24h != null && ` · ${status.restarts_24h} restart${status.restarts_24h === 1 ? '' : 's'} (24h)`}
            </div>
          </div>
          <div className="flex-1" />
          <button
            onClick={() => setRawMode(r => !r)}
            className="font-mono uppercase cursor-pointer"
            title="Toggle raw terminal pane"
            style={{
              padding: '4px 10px', fontSize: 10, fontWeight: 600, letterSpacing: '0.1em',
              border: '1px solid var(--color-border)',
              background: rawMode ? 'var(--color-brand)' : 'transparent',
              color: rawMode ? 'var(--color-brand-foreground)' : 'var(--color-foreground-muted)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            Raw
          </button>
          <label className="flex items-center gap-2 text-[12px] text-[var(--color-foreground-muted)] cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              className="cursor-pointer accent-[var(--color-brand)]"
            />
            Auto
          </label>
          <button onClick={() => { fetchStatus(); fetchLog(); }} className="btn btn-secondary btn-sm">
            <IconRefresh width={12} height={12} />
            Refresh
          </button>
        </div>

        {/* Body */}
        <div
          ref={threadRef}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto px-5 py-4"
        >
          {statusError && (
            <div className="px-3 py-2 mb-3 rounded-md text-[12px] font-mono"
                 style={{ background: 'var(--color-error-soft)', border: '1px solid var(--color-error-border)', color: 'var(--color-error)' }}>
              status fetch failed: {statusError}
            </div>
          )}
          {logError && (
            <div className="px-3 py-2 mb-3 rounded-md text-[11px] font-mono"
                 style={{ background: 'var(--color-error-soft)', border: '1px solid var(--color-error-border)', color: 'var(--color-error)' }}>
              log fetch failed: {logError}
            </div>
          )}

          {rawMode ? (
            <pre
              className="terminal-pane whitespace-pre-wrap break-words"
              style={{ fontSize: 11.5, lineHeight: 1.45 }}
            >
              {cleanLog || <span className="opacity-40">(empty)</span>}
            </pre>
          ) : (
            <div className="flex flex-col gap-2.5">
              {blocks.length === 0 && (
                <div className="text-[12px] text-[var(--color-foreground-faint)] italic">
                  Pane is empty. Shelly may have just restarted.
                </div>
              )}
              {blocks.map((b, i) =>
                b.kind === 'event'
                  ? <EventCapsule key={i} tag={b.tag} body={b.body} />
                  : <ProseBlock key={i} body={b.body} />
              )}
            </div>
          )}
        </div>
      </div>

      <EphemeralsRail apiUrl={apiUrl} apiKey={apiKey} />
    </div>
  );
}
