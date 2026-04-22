// src/dashboard/views/shelly-view.jsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { IconRefresh } from '@/components/icons';

const STATUS_POLL_MS = 10_000;
const LOG_POLL_MS    = 5_000;
const LOG_LINES      = 200;

function StatusPill({ status }) {
  let label = 'DOWN', tone = 'error';
  if (status?.healthy) { label = 'HEALTHY'; tone = 'success'; }
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

export function ShellyView({ apiUrl, apiKey }) {
  const [status, setStatus]       = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [log, setLog]             = useState('');
  const [logError, setLogError]   = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const logRef = useRef(null);
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
    if (!logRef.current || !stickyBottomRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  function onLogScroll() {
    if (!logRef.current) return;
    const el = logRef.current;
    stickyBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  const cleanLog = log
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\r/g, '');

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 h-14 border-b border-[var(--color-border-subtle)] shrink-0">
        <h1 className="text-[15px] font-semibold tracking-tight">Shelly</h1>
        <span className="text-[12px] text-[var(--color-foreground-faint)]">Telegram orchestration agent</span>
        {status && <StatusPill status={status} />}
        <div className="flex-1" />
        <label className="flex items-center gap-2 text-[12px] text-[var(--color-foreground-muted)] cursor-pointer">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={e => setAutoRefresh(e.target.checked)}
            className="cursor-pointer accent-[var(--color-brand)]"
          />
          Auto-refresh
        </label>
        <button onClick={() => { fetchStatus(); fetchLog(); }} className="btn btn-secondary btn-sm">
          <IconRefresh width={12} height={12} />
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
        {statusError && (
          <div className="px-3 py-2 rounded-md text-[12px] font-mono"
               style={{ background: 'var(--color-error-soft)', border: '1px solid var(--color-error-border)', color: 'var(--color-error)' }}>
            status fetch failed: {statusError}
          </div>
        )}

        <div className="metric-strip" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          <div className="metric-cell">
            <span className="label">Claude</span>
            <span className="value" style={{ fontSize: 14 }}>
              {status?.claude_running ? `pid ${status.claude_pid}` : '—'}
            </span>
          </div>
          <div className="metric-cell">
            <span className="label">Bun (telegram)</span>
            <span className="value" style={{ fontSize: 14 }}>
              {status?.bun_running ? `pid ${status.bun_pid}` : '—'}
            </span>
          </div>
          <div className="metric-cell">
            <span className="label">Restarts (24h)</span>
            <span className="value">{status?.restarts_24h ?? '—'}</span>
          </div>
          <div className="metric-cell">
            <span className="label">Last restart</span>
            <span className="value" style={{ fontSize: 14 }}>{timeAgo(status?.last_restart)}</span>
            {status?.last_restart_reason && (
              <span className="delta truncate" title={status.last_restart_reason}>
                {status.last_restart_reason}
              </span>
            )}
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-[11px] uppercase tracking-wider font-semibold text-[var(--color-foreground-muted)]">
              Pane log
            </h2>
            <span className="text-[11px] text-[var(--color-foreground-faint)] font-mono">last {LOG_LINES} lines</span>
            <div className="flex-1" />
            {logError && <span className="text-[11px] text-[var(--color-error)] font-mono">{logError}</span>}
          </div>
          <div
            ref={logRef}
            onScroll={onLogScroll}
            className="terminal-pane whitespace-pre-wrap break-words"
            style={{ maxHeight: '60vh', overflowY: 'auto' }}
          >
            {cleanLog || <span className="opacity-40">(empty)</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
