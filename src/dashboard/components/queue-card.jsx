import { useState } from "react";

const STATUS_DOT = {
  healthy:     'var(--color-success)',
  warning:     'var(--color-warning)',
  critical:    'var(--color-error)',
  unreachable: 'var(--color-error)',
};

// Compact horizontal stat row inside the queue chip — every queue card was
// 220px wide before, now they fit 6+ on a row without the eyestrain.
const COUNT_KEYS = [
  { key: "waiting",   label: "wait",   tone: 'var(--color-warning)' },
  { key: "active",    label: "active", tone: 'var(--color-info)' },
  { key: "delayed",   label: "delay",  tone: 'var(--color-foreground-muted)' },
  { key: "failed",    label: "fail",   tone: 'var(--color-error)' },
  { key: "completed", label: "done",   tone: 'var(--color-success)' },
];

export function QueueCard({ queue, selected, onSelect, apiUrl, adminKey }) {
  const [acting, setActing] = useState(false);
  const c = queue.counts || {};
  const shortName = queue.queue.replace("devpanel:", "");

  async function adminAction(action) {
    setActing(true);
    try {
      await fetch(`${apiUrl}/api/queues/${shortName}/${action}`, {
        method: "POST",
        headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
        body: action === "clean" ? JSON.stringify({ status: "completed" }) : undefined,
      });
    } catch {
      // SSE will refresh state.
    }
    setActing(false);
  }

  const dot = STATUS_DOT[queue.status] || 'var(--color-foreground-faint)';

  return (
    <div
      onClick={() => onSelect(shortName)}
      className="rounded-lg p-3 cursor-pointer transition-colors shrink-0"
      style={{
        width: 200,
        background: selected ? 'var(--color-surface-3)' : 'var(--color-surface-1)',
        border: `1px solid ${selected ? 'var(--color-info)' : 'var(--color-border-subtle)'}`,
        boxShadow: selected ? '0 0 0 1px var(--color-info-soft)' : 'none',
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--color-surface-2)'; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'var(--color-surface-1)'; }}
    >
      <div className="flex items-center gap-1.5 mb-2">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />
        <span className="text-[12px] font-mono font-medium text-[var(--color-foreground)] truncate flex-1">{shortName}</span>
        {queue.paused && (
          <span
            className="font-mono text-[9px] px-1 rounded uppercase tracking-wider"
            style={{ color: 'var(--color-warning)', background: 'var(--color-warning-soft)' }}
          >
            paused
          </span>
        )}
      </div>

      {/* Proportional 5-segment bar — borrowed from the Claude Design queue
          card. Each segment's flex value is its raw count, so the bar shows
          true proportions (a queue with 128 done + 3 wait reads as mostly
          green). Empty queues get a thin neutral bar so the row doesn't jump
          when the first job lands. */}
      {(() => {
        const total = COUNT_KEYS.reduce((s, { key }) => s + (c[key] || 0), 0);
        return (
          <div className="flex h-1.5 mb-2 rounded-sm overflow-hidden" style={{ background: 'var(--color-surface-3)' }}>
            {total === 0 ? (
              <div className="flex-1" />
            ) : (
              COUNT_KEYS.map(({ key, tone }) => {
                const v = c[key] || 0;
                if (v === 0) return null;
                const isActive = key === 'active';
                return (
                  <div
                    key={key}
                    style={{
                      flex: v,
                      background: tone,
                      boxShadow: isActive ? `0 0 8px ${tone}` : 'none',
                    }}
                  />
                );
              })
            )}
          </div>
        );
      })()}

      <div className="grid grid-cols-5 gap-1">
        {COUNT_KEYS.map(({ key, label, tone }) => {
          const v = c[key] || 0;
          const dim = v === 0;
          return (
            <div key={key} className="flex flex-col items-center py-1 rounded" style={{ background: dim ? 'transparent' : 'var(--color-surface-2)' }}>
              <span className="text-[12px] font-bold tabular-nums" style={{ color: dim ? 'var(--color-foreground-faint)' : tone }}>{v}</span>
              <span className="text-[8.5px] font-mono mt-0.5" style={{ color: 'var(--color-foreground-faint)' }}>{label}</span>
            </div>
          );
        })}
      </div>

      {adminKey && (
        <div
          className="flex gap-2 mt-2 pt-2"
          style={{ borderTop: '1px solid var(--color-border-subtle)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => adminAction(queue.paused ? "resume" : "pause")}
            disabled={acting}
            className="text-[10.5px] font-mono cursor-pointer disabled:opacity-50 transition-colors"
            style={{ color: 'var(--color-foreground-faint)' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--color-foreground)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--color-foreground-faint)'}
          >
            {queue.paused ? "Resume" : "Pause"}
          </button>
          <button
            onClick={() => adminAction("clean")}
            disabled={acting}
            className="text-[10.5px] font-mono cursor-pointer disabled:opacity-50 transition-colors"
            style={{ color: 'var(--color-foreground-faint)' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--color-foreground)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--color-foreground-faint)'}
          >
            Clean done
          </button>
        </div>
      )}
    </div>
  );
}
