// src/dashboard/views/fleet-view.jsx
// Bloomberg-density fleet grid: one row per active workflow instance.
// Per-task autonomy slider, status glyph, drill-into rail with event timeline.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { IconRefresh, IconClose, IconRunning, IconExhausted, IconFailed, IconFinished } from '@/components/icons';
import { timeAgo } from '@/lib/time';
import { useLiveEvent } from '@/lib/live';

const STATUS_TONE = {
  running:           { fg: 'var(--color-success)', bg: 'var(--color-success-soft)', label: 'RUNNING'   },
  awaiting_approval: { fg: 'var(--color-warning)', bg: 'var(--color-warning-soft)', label: 'WAITING'   },
  blocked:           { fg: 'var(--color-error)',   bg: 'var(--color-error-soft)',   label: 'BLOCKED'   },
  exhausted:         { fg: 'var(--color-error)',   bg: 'var(--color-error-soft)',   label: 'EXHAUSTED' },
  done:              { fg: 'var(--color-success)', bg: 'var(--color-success-soft)', label: 'DONE'      },
  cancelled:         { fg: 'var(--color-foreground-muted)', bg: 'var(--color-surface-2)', label: 'CANCEL' },
};

const AUTONOMY_TONE = {
  low:  { fg: 'var(--color-error)',   label: 'LOW'  },
  med:  { fg: 'var(--color-info)',    label: 'MED'  },
  high: { fg: 'var(--color-success)', label: 'HIGH' },
};

function FleetRow({ row, active, onClick }) {
  const tone = STATUS_TONE[row.status] || STATUS_TONE.cancelled;
  const aut = AUTONOMY_TONE[row.autonomy] || AUTONOMY_TONE.med;
  return (
    <div onClick={onClick}
      className={`grid items-center gap-2 px-3 h-8 cursor-pointer border-l-2 ${active ? 'bg-[var(--color-surface-2)] border-l-[var(--color-foreground)]' : 'border-l-transparent hover:bg-[var(--color-surface-2)]'}`}
      style={{ fontSize: 12, gridTemplateColumns: '76px 90px 130px 110px 1fr 60px 60px 60px' }}>
      <span className="px-1.5 py-0.5 rounded-sm font-mono uppercase tracking-wider text-center"
        style={{ color: tone.fg, background: tone.bg, fontSize: 9, fontWeight: 600 }}>
        {tone.label}
      </span>
      <span className="font-mono truncate text-[var(--color-foreground)]">
        {row.agent || row.workflow}
      </span>
      <span className="truncate text-[var(--color-foreground-muted)]">
        {row.project_name || '—'}
      </span>
      <span className="font-mono truncate text-[var(--color-foreground)]">
        {row.identifier || row.work_item_id?.slice(0, 8) || '—'}
      </span>
      <span className="truncate text-[var(--color-foreground-muted)]">
        {row.current_step || '—'}
      </span>
      <span className="text-center font-mono" style={{ color: aut.fg, fontSize: 10 }}>
        {aut.label}
      </span>
      <span className="text-center font-mono text-[var(--color-foreground-faint)]" style={{ fontSize: 10 }}>
        {timeAgo(row.last_event_at)}
      </span>
      <span className="text-right font-mono text-[var(--color-foreground-faint)] truncate" style={{ fontSize: 10 }}>
        {row.last_job_id ? row.last_job_id.slice(0, 8) : '—'}
      </span>
    </div>
  );
}

// Totals strip — derived from the same `agents[]` already in state, so it
// stays in sync with the row list without an extra fetch. Each cell is a
// large tabular number over a small mono caption; color cues the state.
function FleetTotals({ counts }) {
  const cells = [
    { n: counts.running, label: 'running',  color: 'var(--color-brand-glow)' },
    { n: counts.waiting, label: 'waiting',  color: 'var(--color-warning)' },
    { n: counts.blocked, label: 'stuck',    color: 'var(--color-error)' },
    { n: counts.done,    label: 'done',     color: 'var(--color-success)' },
  ];
  return (
    <div
      className="flex shrink-0 border-b border-[var(--color-border-subtle)]"
      style={{ background: 'var(--color-surface-1)' }}
    >
      {cells.map((c, i) => (
        <div
          key={c.label}
          className="flex-1 flex flex-col gap-1 px-5 py-3"
          style={{
            borderRight: i < cells.length - 1 ? '1px solid var(--color-border-subtle)' : 'none',
          }}
        >
          <span
            className="font-mono"
            style={{
              color: c.color,
              fontSize: 26,
              lineHeight: 1,
              fontWeight: 500,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.02em',
            }}
          >
            {c.n}
          </span>
          <span
            className="uppercase font-mono"
            style={{
              color: 'var(--color-foreground-faint)',
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: '0.14em',
            }}
          >
            {c.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function FleetHeader() {
  return (
    <div
      className="grid items-center gap-2 px-3 h-7 sticky top-0 z-10 uppercase tracking-wider"
      style={{
        fontSize: 9,
        fontWeight: 600,
        color: 'var(--color-foreground-faint)',
        background: 'var(--color-surface)',
        borderBottom: '1px solid var(--color-border-subtle)',
        gridTemplateColumns: '76px 90px 130px 110px 1fr 60px 60px 60px',
      }}
    >
      <span className="text-center">Status</span>
      <span>Agent</span>
      <span>Project</span>
      <span>Work item</span>
      <span>Step</span>
      <span className="text-center">Auton</span>
      <span className="text-center">Age</span>
      <span className="text-right">Job</span>
    </div>
  );
}

// Coerce BIGINT-as-string from node-postgres into a JS Date. Mirrors the
// shared timeAgo helper but renders an absolute timestamp instead of "Nm".
// Returns null when input can't be parsed so the caller renders "—".
function asDate(input) {
  if (input == null || input === '') return null;
  let ts;
  if (typeof input === 'number') ts = input;
  else if (/^\d+$/.test(String(input).trim())) ts = parseInt(String(input).trim(), 10);
  else {
    const s = String(input);
    ts = Date.parse(s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z'));
  }
  if (!Number.isFinite(ts)) return null;
  return new Date(ts);
}

function DetailRail({ row, apiUrl, apiKey, onClose, onRefresh }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reply, setReply] = useState('');
  const [replyOpen, setReplyOpen] = useState(false);

  async function postFleetAction(action, body = {}) {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${apiUrl}/api/fleet/${row.instance_id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      onRefresh?.();
      return await r.json();
    } catch (e) { setError(e.message); throw e; }
    finally { setBusy(false); }
  }

  async function setAutonomy(autonomy) { await postFleetAction('autonomy', { autonomy }); }
  async function approve()             { await postFleetAction('approve');                 }
  async function retry()                { await postFleetAction('retry');                   }
  async function cancel() {
    if (!window.confirm('Cancel this workflow instance?')) return;
    await postFleetAction('cancel');
    onClose();
  }

  // Reply hits the existing /api/threads/:type/:id/messages — the same
  // pipe Shelly uses for capture/work_item conversations. Lands in
  // Telegram with the [thread:work_item/<id>] tag so the response routes
  // back. This is the "talk to the agent that's stuck" affordance.
  async function sendReply() {
    if (!reply.trim()) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${apiUrl}/api/threads/work_item/${encodeURIComponent(row.work_item_id)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ content: reply.trim(), role: 'user' }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setReply(''); setReplyOpen(false);
      onRefresh?.();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const startedDate = asDate(row.started_at);
  const isBlocked = ['blocked', 'exhausted'].includes(row.status);
  const isWaiting = row.status === 'awaiting_approval';
  const isRunning = row.status === 'running';
  const isTerminal = ['done', 'cancelled'].includes(row.status);

  const tone = STATUS_TONE[row.status] || STATUS_TONE.cancelled;
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 h-12 px-4 border-b border-[var(--color-border-subtle)]">
        <span className="px-1.5 py-0.5 rounded-sm font-mono uppercase tracking-wider"
          style={{ color: tone.fg, background: tone.bg, fontSize: 9, fontWeight: 600 }}>
          {tone.label}
        </span>
        <span className="text-[12px] font-medium">{row.identifier || row.work_item_id?.slice(0, 8)}</span>
        <span className="text-[11px] text-[var(--color-foreground-faint)]">{row.workflow}</span>
        <div className="flex-1" />
        <button onClick={onClose} className="cursor-pointer text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)]">
          <IconClose width={14} height={14} />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="text-[13px] text-[var(--color-foreground)]">{row.title || '(no title)'}</div>
        <dl className="text-[11px] space-y-1.5">
          <div className="flex"><dt className="w-32 text-[var(--color-foreground-faint)]">Agent</dt><dd className="font-mono">{row.agent || '—'}</dd></div>
          <div className="flex"><dt className="w-32 text-[var(--color-foreground-faint)]">Project</dt><dd>{row.project_name || '—'}</dd></div>
          <div className="flex"><dt className="w-32 text-[var(--color-foreground-faint)]">Workflow</dt><dd className="font-mono">{row.workflow} (rev {row.revision})</dd></div>
          <div className="flex"><dt className="w-32 text-[var(--color-foreground-faint)]">Current step</dt><dd>{row.current_step || '—'}</dd></div>
          <div className="flex"><dt className="w-32 text-[var(--color-foreground-faint)]">Last step</dt><dd>{row.last_step_status || '—'} {row.last_step_duration_ms ? `(${row.last_step_duration_ms}ms)` : ''}</dd></div>
          {row.last_step_error && (
            <div className="flex"><dt className="w-32 text-[var(--color-foreground-faint)]">Last error</dt><dd className="text-[var(--color-error)] font-mono text-[10px] whitespace-pre-wrap">{row.last_step_error}</dd></div>
          )}
          <div className="flex"><dt className="w-32 text-[var(--color-foreground-faint)]">Started</dt><dd>{startedDate ? startedDate.toLocaleString() : '—'}</dd></div>
          <div className="flex"><dt className="w-32 text-[var(--color-foreground-faint)]">Last event</dt><dd>{timeAgo(row.last_event_at)}</dd></div>
          <div className="flex"><dt className="w-32 text-[var(--color-foreground-faint)]">Job</dt><dd className="font-mono">{row.last_job_id || '—'}</dd></div>
          {row.plane_url && (
            <div className="flex"><dt className="w-32 text-[var(--color-foreground-faint)]">Plane</dt><dd><a href={row.plane_url} target="_blank" rel="noopener" className="text-[var(--color-info)] hover:underline">open ↗</a></dd></div>
          )}
        </dl>

        <div className="border-t border-[var(--color-border-subtle)] pt-4">
          <div className="text-[10px] uppercase tracking-widest text-[var(--color-foreground-faint)] mb-2">Autonomy</div>
          <div className="flex gap-1">
            {['low', 'med', 'high'].map(a => (
              <button key={a} onClick={() => setAutonomy(a)} disabled={busy}
                className={`flex-1 h-8 rounded text-[11px] uppercase tracking-wider cursor-pointer ${row.autonomy === a ? 'bg-[var(--color-foreground)] text-[var(--color-background)]' : 'bg-[var(--color-surface-2)] text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)]'}`}>
                {a}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-[var(--color-foreground-faint)] mt-2">
            Low — always ask. Med — ask on blockers. High — run to completion.
          </div>
        </div>

        {/* Reply composer — opens a thread to the agent. Same pipe Shelly
            uses, so the message lands in Telegram with the right tag. */}
        {replyOpen && (
          <div className="border-t border-[var(--color-border-subtle)] pt-4">
            <div className="text-[10px] uppercase tracking-widest text-[var(--color-foreground-faint)] mb-2">Reply to agent</div>
            <textarea value={reply} onChange={e => setReply(e.target.value)} rows={3}
              placeholder="What does the agent need to know?"
              className="w-full px-2 py-1.5 text-[12px] rounded outline-none resize-none"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-foreground)' }} />
            <div className="flex gap-2 mt-2">
              <button onClick={() => { setReplyOpen(false); setReply(''); }} disabled={busy}
                className="px-3 h-7 rounded text-[11px] cursor-pointer text-[var(--color-foreground-faint)]">Cancel</button>
              <div className="flex-1" />
              <button onClick={sendReply} disabled={busy || !reply.trim()}
                className="px-3 h-7 rounded text-[11px] cursor-pointer disabled:opacity-50"
                style={{ background: 'var(--color-foreground)', color: 'var(--color-background)' }}>
                Send
              </button>
            </div>
          </div>
        )}

        {error && <div className="text-[11px] text-[var(--color-error)]">Error: {error}</div>}
      </div>

      {/* Action footer — verbs are state-aware. Nothing dumber than seeing
          only "Cancel" when the workflow is genuinely waiting on a human
          decision, which is the bug Franck flagged in the screenshot. */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-t border-[var(--color-border-subtle)] flex-wrap">
        {isWaiting && (
          <button onClick={approve} disabled={busy}
            className="px-3 h-7 rounded text-[11px] cursor-pointer disabled:opacity-50 font-medium"
            style={{ background: 'var(--color-success-soft)', color: 'var(--color-success)' }}>
            Approve & continue
          </button>
        )}
        {isBlocked && (
          <button onClick={retry} disabled={busy}
            className="px-3 h-7 rounded text-[11px] cursor-pointer disabled:opacity-50 font-medium"
            style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning)' }}>
            Retry
          </button>
        )}
        <button onClick={() => setReplyOpen(o => !o)} disabled={busy || isTerminal}
          className="px-3 h-7 rounded text-[11px] cursor-pointer disabled:opacity-50"
          style={{ background: 'var(--color-surface-2)', color: 'var(--color-foreground)' }}>
          {replyOpen ? 'Close reply' : 'Reply'}
        </button>
        {row.plane_url && (
          <a href={row.plane_url} target="_blank" rel="noopener"
            className="px-3 h-7 rounded text-[11px] cursor-pointer flex items-center"
            style={{ background: 'var(--color-surface-2)', color: 'var(--color-foreground-muted)' }}>
            Plane ↗
          </a>
        )}
        <div className="flex-1" />
        <button onClick={cancel} disabled={busy || isTerminal}
          className="px-3 h-7 rounded text-[11px] cursor-pointer disabled:opacity-50"
          style={{ background: 'var(--color-error-soft)', color: 'var(--color-error)' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function FleetView({ apiUrl, apiKey }) {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [degraded, setDegraded] = useState(false);
  const [statusFilter, setStatusFilter] = useState('active');
  const [activeIdx, setActiveIdx] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);

  const load = useCallback(async () => {
    if (!apiKey) return;
    try {
      const r = await fetch(`${apiUrl}/api/fleet?status=${statusFilter}`, {
        headers: { 'X-API-Key': apiKey },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setAgents(d.agents || []);
      setDegraded(!!d.degraded);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, apiKey, statusFilter]);

  useEffect(() => { load(); }, [load]);
  // Real-time push instead of poll spam — workflow_instances.js + jobs-log.js
  // broadcast on every write. Fall back to a 30s safety poll for tabs that
  // were backgrounded long enough for the EventSource to drop.
  useLiveEvent('workflow:changed', () => { load(); }, { apiUrl, apiKey });
  useLiveEvent('agent_step',       () => { load(); }, { apiUrl, apiKey });
  useEffect(() => { const id = setInterval(load, 30_000); return () => clearInterval(id); }, [load]);

  const counts = useMemo(() => ({
    total: agents.length,
    running: agents.filter(a => a.status === 'running').length,
    waiting: agents.filter(a => a.status === 'awaiting_approval').length,
    blocked: agents.filter(a => ['blocked', 'exhausted'].includes(a.status)).length,
    done: agents.filter(a => a.status === 'done').length,
  }), [agents]);

  const active = agents[activeIdx];

  // j/k navigation
  useEffect(() => {
    function onKey(e) {
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
      switch (e.key) {
        case 'j': case 'ArrowDown':
          e.preventDefault();
          setActiveIdx(i => Math.min(i + 1, agents.length - 1));
          return;
        case 'k': case 'ArrowUp':
          e.preventDefault();
          setActiveIdx(i => Math.max(0, i - 1));
          return;
        case 'Enter':
          if (active) setDetailOpen(true);
          return;
        case 'Escape':
          if (detailOpen) setDetailOpen(false);
          return;
        default: break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [agents.length, active, detailOpen]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* min-w-0 lets flex-1 shrink the list when the rail opens; min-width
          on the inner scroll container holds the dense grid (~700px) and
          enables horizontal scroll inside the list rather than letting
          column headers clip. Less ideal at very narrow widths but
          honest — Bloomberg-density columns can't truthfully fit in 290px. */}
      <div className="flex-1 flex flex-col min-w-0 border-r border-[var(--color-border-subtle)]">
        <div className="flex items-center gap-3 h-12 px-4 border-b border-[var(--color-border-subtle)] shrink-0">
          <h1 className="text-[14px] font-semibold tracking-tight">Fleet</h1>
          <span className="text-[11px] text-[var(--color-foreground-faint)]">
            {counts.total} {counts.total === 1 ? 'instance' : 'instances'}
            {degraded && ' (degraded)'}
          </span>
          <div className="flex-1" />
          <div className="flex items-center gap-1">
            {[
              { k: 'active', label: `active ${counts.running + counts.waiting + counts.blocked}` },
              { k: 'all',    label: `all (24h)` },
            ].map(f => (
              <button key={f.k} onClick={() => setStatusFilter(f.k)}
                className={`px-2 h-6 rounded text-[10.5px] uppercase tracking-wider font-medium cursor-pointer ${statusFilter === f.k ? 'bg-[var(--color-surface-2)] text-[var(--color-foreground)]' : 'text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)]'}`}>
                {f.label}
              </button>
            ))}
          </div>
          <button onClick={load} className="h-7 w-7 rounded cursor-pointer text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)]" title="refresh">
            <IconRefresh width={12} height={12} className="mx-auto" />
          </button>
        </div>

        <FleetTotals counts={counts} />

        <div className="flex-1 overflow-auto">
          <div style={{ minWidth: 720 }}>
          <FleetHeader />
          {error && <div className="px-4 py-3 text-[12px] text-[var(--color-error)]">Error: {error}</div>}
          {loading && agents.length === 0 && (
            <div className="px-6 py-16 text-center text-[12px] text-[var(--color-foreground-faint)]">Loading fleet…</div>
          )}
          {!loading && agents.length === 0 && !error && (
            <div className="px-6 py-16 text-center">
              <div className="text-[12px] text-[var(--color-foreground-faint)] mb-1">No active workflows.</div>
              <div className="text-[11px] text-[var(--color-foreground-faint)]">When agents start, they show up here.</div>
            </div>
          )}
          {agents.map((row, i) => (
            <FleetRow key={row.instance_id} row={row}
              active={activeIdx === i}
              onClick={() => { setActiveIdx(i); setDetailOpen(true); }} />
          ))}
          </div>
        </div>
      </div>

      {detailOpen && active && (
        <div className="w-[440px] shrink-0 flex flex-col bg-[var(--color-surface)] border-l border-[var(--color-border-subtle)]">
          <DetailRail row={active} apiUrl={apiUrl} apiKey={apiKey}
            onClose={() => setDetailOpen(false)} onRefresh={load} />
        </div>
      )}
    </div>
  );
}
