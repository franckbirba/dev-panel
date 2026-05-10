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
  awaiting_input:    { fg: 'var(--color-info)',    bg: 'var(--color-info-soft)',    label: 'ASKING'    },
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

// Card view — narrative row built around `current_step` as italic prose.
// We don't have step-N-of-M counts upstream, so the bar is indeterminate
// for `running`, hatched for `blocked/exhausted`, full for `awaiting_approval`,
// and absent for terminal states. Action buttons are state-aware: nothing
// dumber than offering "Approve" on a workflow that's already done.
const STATE_NARRATION = {
  running:           { prefix: 'now',     fg: 'var(--color-brand-glow)' },
  awaiting_approval: { prefix: 'waiting', fg: 'var(--color-warning)'    },
  blocked:           { prefix: 'stuck',   fg: 'var(--color-error)'      },
  exhausted:         { prefix: 'stuck',   fg: 'var(--color-error)'      },
  done:              { prefix: 'done',    fg: 'var(--color-success)'    },
  cancelled:         { prefix: 'idle',    fg: 'var(--color-foreground-faint)' },
};

function ProgressBar({ status }) {
  const baseStyle = {
    height: 3,
    background: 'var(--color-surface-3)',
    position: 'relative',
    overflow: 'hidden',
    borderTop: '1px solid var(--color-border-subtle)',
    borderBottom: '1px solid var(--color-border-subtle)',
  };
  if (status === 'running') {
    return (
      <div style={baseStyle}>
        <div
          className="fleet-bar-indeterminate"
          style={{
            position: 'absolute', top: 0, bottom: 0, width: '30%',
            background: 'var(--color-brand-glow)',
            boxShadow: '0 0 10px var(--color-brand-glow)',
          }}
        />
      </div>
    );
  }
  if (status === 'awaiting_approval') {
    return (
      <div style={baseStyle}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'var(--color-warning)',
          boxShadow: '0 0 10px var(--color-warning)',
        }} />
      </div>
    );
  }
  if (status === 'blocked' || status === 'exhausted') {
    return (
      <div style={{
        ...baseStyle,
        background: 'repeating-linear-gradient(90deg, var(--color-error), var(--color-error) 4px, transparent 4px, transparent 8px)',
      }} />
    );
  }
  return <div style={baseStyle} />;
}

function FleetCard({ row, active, onClick, onAction }) {
  const tone = STATUS_TONE[row.status] || STATUS_TONE.cancelled;
  const narr = STATE_NARRATION[row.status] || STATE_NARRATION.cancelled;
  const isWaiting = row.status === 'awaiting_approval';
  const isBlocked = ['blocked', 'exhausted'].includes(row.status);
  const isRunning = row.status === 'running';
  const isTerminal = ['done', 'cancelled'].includes(row.status);

  // Pick the most informative narration: current_step is the live "what".
  // Fall back to last_step_error for blocked rows since the error is the
  // only signal of what went wrong.
  const narration = isBlocked && row.last_step_error
    ? row.last_step_error.split('\n')[0].slice(0, 200)
    : (row.current_step || row.title || '(no step)');

  function btn(label, kind, handler) {
    const styles = {
      go:     { background: 'var(--color-brand)',       color: 'var(--color-brand-foreground)', borderColor: 'var(--color-brand)' },
      ghost:  { background: 'transparent',               color: 'var(--color-foreground-muted)', borderColor: 'var(--color-border)' },
      danger: { background: 'transparent',               color: 'var(--color-error)',            borderColor: 'var(--color-error-border)' },
    };
    return (
      <button
        key={label}
        onClick={(e) => { e.stopPropagation(); handler(); }}
        className="font-mono uppercase cursor-pointer transition-colors"
        style={{
          ...styles[kind],
          border: `1px solid ${styles[kind].borderColor}`,
          fontSize: 10, fontWeight: 600, letterSpacing: '0.1em',
          padding: '4px 10px', minWidth: 70, textAlign: 'center',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div
      onClick={onClick}
      className={`grid items-center gap-4 px-5 py-4 border-b border-[var(--color-border-subtle)] cursor-pointer ${active ? 'bg-[var(--color-surface-2)]' : 'hover:bg-[var(--color-surface-2)]'}`}
      style={{ gridTemplateColumns: '72px 1fr 200px 86px' }}
    >
      <div
        className="font-mono uppercase text-center"
        style={{
          color: tone.fg,
          fontSize: 10, fontWeight: 600, letterSpacing: '0.14em',
          padding: '6px 0',
          borderTop: `2px solid ${tone.fg}`,
          borderBottom: `2px solid ${tone.fg}`,
        }}
      >
        {row.agent || row.workflow}
      </div>

      <div className="min-w-0">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-[14px] font-medium text-[var(--color-foreground)] truncate">
            {row.identifier || row.title || row.work_item_id?.slice(0, 8) || '—'}
          </span>
          <span className="font-mono text-[10.5px] text-[var(--color-foreground-faint)] truncate">
            {row.last_job_id ? `job ${row.last_job_id.slice(0, 4)}` : null}
            {row.project_name ? ` · ${row.project_name}` : null}
          </span>
        </div>
        <div className="text-[12.5px] leading-snug text-[var(--color-foreground-muted)] truncate">
          <span
            className="font-mono uppercase mr-2"
            style={{ color: narr.fg, fontSize: 10, fontWeight: 600, letterSpacing: '0.12em' }}
          >
            {narr.prefix} ›
          </span>
          <span style={{ fontStyle: 'italic' }}>{narration}</span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between font-mono text-[10px] text-[var(--color-foreground-faint)]">
          <span>{row.last_step_status || '—'}</span>
          <span>{timeAgo(row.last_event_at)}</span>
        </div>
        <ProgressBar status={row.status} />
      </div>

      <div className="flex flex-col gap-1.5 items-end">
        {isWaiting  && btn('Approve', 'go',     () => onAction(row, 'approve'))}
        {isBlocked  && btn('Retry',   'go',     () => onAction(row, 'retry'))}
        {isRunning  && btn('Tail',    'ghost',  () => onAction(row, 'tail'))}
        {isWaiting  && btn('Tail',    'ghost',  () => onAction(row, 'tail'))}
        {!isTerminal && btn('Cancel', 'danger', () => onAction(row, 'cancel'))}
      </div>
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
  const [pendingQuestion, setPendingQuestion] = useState(null);

  // When the workflow is in awaiting_input, fetch the latest unanswered
  // question so we can render it inline above the reply box. The agent has
  // told us exactly what it's stuck on — show it.
  useEffect(() => {
    if (row.status !== 'awaiting_input' || !row.last_job_id) {
      setPendingQuestion(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `${apiUrl}/api/jobs/${encodeURIComponent(row.last_job_id)}/inbox/history`,
          { headers: { 'X-API-Key': apiKey } }
        );
        if (!r.ok) return;
        const { messages = [] } = await r.json();
        // Latest unconsumed agent_question = the one waiting for an answer.
        const q = [...messages].reverse().find(
          m => m.role === 'agent_question' && !m.consumed_at
        );
        if (!cancelled) setPendingQuestion(q || null);
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [row.status, row.last_job_id, apiUrl, apiKey]);

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

  // Reply routes by workflow status:
  //  - awaiting_input  → POST /api/jobs/:job_id/inbox/reply
  //                      The agent is paused on `await_human` and will
  //                      resume the moment this row hits job_inbox.
  //  - everything else → POST /api/threads/work_item/:id/messages
  //                      Same pipe Shelly uses for capture/work_item
  //                      conversations. Lands in Telegram with the
  //                      [thread:work_item/<id>] tag.
  async function sendReply() {
    if (!reply.trim()) return;
    setBusy(true); setError(null);
    try {
      const isAwaitingInput = row.status === 'awaiting_input' && row.last_job_id;
      const url = isAwaitingInput
        ? `${apiUrl}/api/jobs/${encodeURIComponent(row.last_job_id)}/inbox/reply`
        : `${apiUrl}/api/threads/work_item/${encodeURIComponent(row.work_item_id)}/messages`;
      const body = isAwaitingInput
        ? {
            answer: reply.trim(),
            source: 'dashboard',
            work_item_id: row.work_item_id,
            workflow_name: row.workflow,
          }
        : { content: reply.trim(), role: 'user' };
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      setReply(''); setReplyOpen(false);
      onRefresh?.();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  // One-tap reply for inline keyboard options on the dashboard side.
  async function sendOptionReply(answer) {
    if (!row.last_job_id) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(
        `${apiUrl}/api/jobs/${encodeURIComponent(row.last_job_id)}/inbox/reply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
          body: JSON.stringify({
            answer,
            source: 'dashboard',
            work_item_id: row.work_item_id,
            workflow_name: row.workflow,
          }),
        }
      );
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      setPendingQuestion(null);
      onRefresh?.();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const startedDate = asDate(row.started_at);
  const isBlocked = ['blocked', 'exhausted'].includes(row.status);
  const isWaiting = row.status === 'awaiting_approval';
  const isAwaitingInput = row.status === 'awaiting_input';
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

        {/* Agent is asking — render the question prominently. If the agent
            offered options, show them as one-tap buttons. Otherwise the
            normal Reply composer below picks up the typed answer. */}
        {isAwaitingInput && pendingQuestion && (
          <div className="border-t border-[var(--color-border-subtle)] pt-4">
            <div className="text-[10px] uppercase tracking-widest text-[var(--color-info)] mb-2">
              Agent is asking
            </div>
            <div className="text-[13px] text-[var(--color-foreground)] mb-2 whitespace-pre-wrap">
              {pendingQuestion.content?.prompt || '(no prompt)'}
            </div>
            {pendingQuestion.kind === 'tool_approval' && pendingQuestion.content?.tool && (
              <div className="text-[11px] text-[var(--color-foreground-faint)] font-mono mb-2">
                Tool: {pendingQuestion.content.tool}
                {pendingQuestion.content.args && (
                  <pre className="mt-1 p-2 rounded bg-[var(--color-surface-2)] overflow-x-auto text-[10px]">
                    {JSON.stringify(pendingQuestion.content.args, null, 2)}
                  </pre>
                )}
              </div>
            )}
            {Array.isArray(pendingQuestion.content?.options) && pendingQuestion.content.options.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {pendingQuestion.content.options.map(opt => (
                  <button key={opt} onClick={() => sendOptionReply(opt)} disabled={busy}
                    className="px-3 h-7 rounded text-[11px] cursor-pointer disabled:opacity-50"
                    style={{ background: 'var(--color-info-soft)', color: 'var(--color-info)' }}>
                    {opt}
                  </button>
                ))}
              </div>
            )}
            {pendingQuestion.kind === 'tool_approval' && (
              <div className="flex gap-1.5 mb-2">
                <button onClick={() => sendOptionReply('allow')} disabled={busy}
                  className="px-3 h-7 rounded text-[11px] cursor-pointer disabled:opacity-50 font-medium"
                  style={{ background: 'var(--color-success-soft)', color: 'var(--color-success)' }}>
                  Allow
                </button>
                <button onClick={() => sendOptionReply('deny')} disabled={busy}
                  className="px-3 h-7 rounded text-[11px] cursor-pointer disabled:opacity-50 font-medium"
                  style={{ background: 'var(--color-error-soft)', color: 'var(--color-error)' }}>
                  Deny
                </button>
              </div>
            )}
          </div>
        )}

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

        {/* Reply composer — when status is awaiting_input, posts to the
            inbox and unblocks the agent immediately. Otherwise opens a
            thread to the work item (same pipe Shelly uses, lands in
            Telegram with the [thread:work_item/<id>] tag). */}
        {replyOpen && (
          <div className="border-t border-[var(--color-border-subtle)] pt-4">
            <div className="text-[10px] uppercase tracking-widest text-[var(--color-foreground-faint)] mb-2">
              {isAwaitingInput ? 'Answer the agent' : 'Reply to agent'}
            </div>
            <textarea value={reply} onChange={e => setReply(e.target.value)} rows={3}
              placeholder={isAwaitingInput
                ? 'Type your answer — the agent resumes the moment you send.'
                : 'What does the agent need to know?'}
              className="w-full px-2 py-1.5 text-[12px] rounded outline-none resize-none"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-foreground)' }} />
            <div className="flex gap-2 mt-2">
              <button onClick={() => { setReplyOpen(false); setReply(''); }} disabled={busy}
                className="px-3 h-7 rounded text-[11px] cursor-pointer text-[var(--color-foreground-faint)]">Cancel</button>
              <div className="flex-1" />
              <button onClick={sendReply} disabled={busy || !reply.trim()}
                className="px-3 h-7 rounded text-[11px] cursor-pointer disabled:opacity-50"
                style={{ background: 'var(--color-foreground)', color: 'var(--color-background)' }}>
                {isAwaitingInput ? 'Send & resume' : 'Send'}
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
  // Persisted across reloads — Bloomberg grid is the default for density;
  // cards are the "let me read what's actually happening" mode.
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem('fleet:viewMode') || 'grid'; } catch { return 'grid'; }
  });
  useEffect(() => {
    try { localStorage.setItem('fleet:viewMode', viewMode); } catch { /* private mode */ }
  }, [viewMode]);

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
    // 'waiting' rolls up both human-gated states: awaiting_approval (pause-on-blocker)
    // and awaiting_input (await_human MCP tool from DEVPA-185). Both mean
    // "agent is paused for a human decision."
    waiting: agents.filter(a => ['awaiting_approval', 'awaiting_input'].includes(a.status)).length,
    blocked: agents.filter(a => ['blocked', 'exhausted'].includes(a.status)).length,
    done: agents.filter(a => a.status === 'done').length,
  }), [agents]);

  const active = agents[activeIdx];

  // Inline card actions — same endpoints DetailRail uses. "tail" just opens
  // the rail (it owns the log/timeline). Cancel keeps the confirm prompt
  // because it's destructive and a card click is much easier to misfire than
  // a deliberate rail-button press.
  const onCardAction = useCallback(async (row, action) => {
    if (action === 'tail') {
      setActiveIdx(agents.findIndex(a => a.instance_id === row.instance_id));
      setDetailOpen(true);
      return;
    }
    if (action === 'cancel' && !window.confirm('Cancel this workflow instance?')) return;
    try {
      const r = await fetch(`${apiUrl}/api/fleet/${row.instance_id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      load();
    } catch (e) {
      setError(`${action} failed: ${e.message}`);
    }
  }, [agents, apiUrl, apiKey, load]);

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
          <div className="flex items-center gap-px ml-1 rounded overflow-hidden border border-[var(--color-border)]">
            {[
              { k: 'grid',  label: 'Grid'  },
              { k: 'cards', label: 'Cards' },
            ].map(v => (
              <button key={v.k} onClick={() => setViewMode(v.k)}
                title={v.k === 'grid' ? 'Bloomberg-density grid' : 'Narrative cards'}
                className={`px-2 h-6 text-[10.5px] uppercase tracking-wider font-medium cursor-pointer ${viewMode === v.k ? 'bg-[var(--color-brand)] text-[var(--color-brand-foreground)]' : 'bg-[var(--color-surface-2)] text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)]'}`}>
                {v.label}
              </button>
            ))}
          </div>
          <button onClick={load} className="h-7 w-7 rounded cursor-pointer text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)]" title="refresh">
            <IconRefresh width={12} height={12} className="mx-auto" />
          </button>
        </div>

        <FleetTotals counts={counts} />

        <div className="flex-1 overflow-auto">
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
          {viewMode === 'grid' && agents.length > 0 && (
            <div style={{ minWidth: 720 }}>
              <FleetHeader />
              {agents.map((row, i) => (
                <FleetRow key={row.instance_id} row={row}
                  active={activeIdx === i}
                  onClick={() => { setActiveIdx(i); setDetailOpen(true); }} />
              ))}
            </div>
          )}
          {viewMode === 'cards' && agents.length > 0 && agents.map((row, i) => (
            <FleetCard key={row.instance_id} row={row}
              active={activeIdx === i}
              onClick={() => { setActiveIdx(i); setDetailOpen(true); }}
              onAction={onCardAction} />
          ))}
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
