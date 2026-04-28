// src/dashboard/components/memory-row.jsx
const KIND_COLORS = {
  decision:       { bg: 'var(--color-info-soft)',    fg: 'var(--color-info)' },
  debug_finding:  { bg: 'var(--color-warning-soft)', fg: 'var(--color-warning)' },
  handoff:        { bg: 'var(--color-success-soft)',  fg: 'var(--color-success)' },
  retrospective:  { bg: 'var(--color-error-soft)',    fg: 'var(--color-error)' },
  spec_note:      { bg: 'var(--color-surface-2)',     fg: 'var(--color-foreground-muted)' },
};

function timeAgo(dateStr) {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1)    return 'now';
  if (min < 60)   return `${min}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}

export function MemoryRow({ memory, onClick }) {
  const colors = KIND_COLORS[memory.kind] || KIND_COLORS.spec_note;
  return (
    <div
      className="flex items-center gap-3 px-4 h-12 hover:bg-[var(--color-surface-2)] transition-colors cursor-pointer border-b border-[var(--color-border-subtle)]"
      onClick={() => onClick?.(memory)}
    >
      <span
        className="px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider shrink-0"
        style={{ background: colors.bg, color: colors.fg }}
      >
        {memory.kind?.replace('_', ' ')}
      </span>
      <div className="flex-1 min-w-0">
        <span className="text-[13px] truncate text-[var(--color-foreground)] block">{memory.title}</span>
        {memory.work_item_id && (
          <span className="text-[11px] text-[var(--color-foreground-faint)] font-mono">{memory.work_item_id.slice(0, 8)}</span>
        )}
      </div>
      <span className="text-[11px] text-[var(--color-foreground-muted)] font-mono shrink-0">{memory.agent}</span>
      {memory.score != null && (
        <span className="text-[10px] text-[var(--color-foreground-faint)] font-mono shrink-0 w-8 text-right">
          {(memory.score * 100).toFixed(0)}%
        </span>
      )}
      <span className="text-[11px] text-[var(--color-foreground-faint)] shrink-0 w-8 text-right">
        {timeAgo(memory.created_at)}
      </span>
    </div>
  );
}
