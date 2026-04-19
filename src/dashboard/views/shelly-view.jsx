import { useState, useEffect, useRef, useCallback } from "react";

const STATUS_POLL_MS = 10_000;
const LOG_POLL_MS = 5_000;
const LOG_LINES = 200;

function StatusBadge({ healthy, claudeRunning, bunRunning }) {
  let label, klass;
  if (healthy) { label = "HEALTHY"; klass = "bg-success/15 text-success"; }
  else if (claudeRunning && !bunRunning) { label = "BUN DOWN"; klass = "bg-error/15 text-error"; }
  else if (!claudeRunning && bunRunning) { label = "CLAUDE DOWN"; klass = "bg-error/15 text-error"; }
  else { label = "DOWN"; klass = "bg-error/15 text-error"; }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-mono font-semibold ${klass}`}>
      {label}
    </span>
  );
}

function timeAgo(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function ShellyView({ apiUrl, apiKey }) {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [log, setLog] = useState("");
  const [logError, setLogError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const logRef = useRef(null);
  const stickyBottomRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(`${apiUrl}/api/shelly/status`, { headers: { "X-API-Key": apiKey } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus(await r.json());
      setStatusError(null);
    } catch (err) { setStatusError(err.message); }
  }, [apiUrl, apiKey]);

  const fetchLog = useCallback(async () => {
    try {
      const r = await fetch(`${apiUrl}/api/shelly/log?lines=${LOG_LINES}`, { headers: { "X-API-Key": apiKey } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      setLog(text);
      setLogError(null);
    } catch (err) { setLogError(err.message); }
  }, [apiUrl, apiKey]);

  useEffect(() => {
    fetchStatus(); fetchLog();
    if (!autoRefresh) return;
    const sId = setInterval(fetchStatus, STATUS_POLL_MS);
    const lId = setInterval(fetchLog, LOG_POLL_MS);
    return () => { clearInterval(sId); clearInterval(lId); };
  }, [autoRefresh, fetchStatus, fetchLog]);

  // Auto-scroll the log to the bottom unless the user has scrolled up.
  useEffect(() => {
    if (!logRef.current || !stickyBottomRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  function onLogScroll() {
    if (!logRef.current) return;
    const el = logRef.current;
    stickyBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  // Strip a few common ANSI escapes so the pane is readable. tmux pipe-pane
  // gives us a TUI buffer with cursor codes; we don't need full vt100 fidelity,
  // just to surface the human-readable text.
  const cleanLog = log
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1B\][^\x07]*\x07/g, "")
    .replace(/\r/g, "");

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold tracking-tight">Shelly</h2>
        {status && <StatusBadge healthy={status.healthy} claudeRunning={status.claude_running} bunRunning={status.bun_running} />}
        <div className="flex-1" />
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="cursor-pointer"
          />
          auto-refresh
        </label>
        <button
          onClick={() => { fetchStatus(); fetchLog(); }}
          className="px-3 py-1 text-xs rounded-md bg-secondary hover:bg-secondary/80 cursor-pointer"
        >refresh</button>
      </div>

      {statusError && (
        <div className="rounded-md border border-error/30 bg-error/5 p-3 text-xs text-error font-mono">
          status fetch failed: {statusError}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Claude</div>
          <div className="mt-1 text-sm font-mono">
            {status?.claude_running ? `pid ${status.claude_pid}` : "—"}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Bun (telegram plugin)</div>
          <div className="mt-1 text-sm font-mono">
            {status?.bun_running ? `pid ${status.bun_pid}` : "—"}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Restarts (24h)</div>
          <div className="mt-1 text-sm font-mono">{status?.restarts_24h ?? "—"}</div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Last restart</div>
          <div className="mt-1 text-sm font-mono">{timeAgo(status?.last_restart)}</div>
          {status?.last_restart_reason && (
            <div className="mt-1 text-[11px] text-muted-foreground truncate" title={status.last_restart_reason}>
              {status.last_restart_reason}
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium">Pane log (last {LOG_LINES} lines)</h3>
          {logError && <span className="text-[11px] text-error">{logError}</span>}
        </div>
        <div
          ref={logRef}
          onScroll={onLogScroll}
          className="rounded-lg border border-border bg-black/90 text-green-100 font-mono text-[11px] leading-relaxed p-3 whitespace-pre-wrap break-words"
          style={{ maxHeight: "60vh", overflowY: "auto" }}
        >
          {cleanLog || <span className="text-muted-foreground">(empty)</span>}
        </div>
      </div>
    </div>
  );
}
