// src/dashboard/components/signal-row.jsx
import { PriorityButtons } from './priority-buttons';

const PRIORITY_EDGE = {
  now: 'border-l-error',
  today: 'border-l-warning',
  later: 'border-l-muted-foreground/40',
};

const TYPE_ICONS = {
  workflow_exhausted: '\u2717',
  workflow_needs_input: '?',
  workflow_running: '\u21BB',
  workflow_finished: '\u2713',
  failed_job: '!',
  capture: '\u25C9',
  deploy_failed: '\u21AF',
  deploy_succeeded: '\u2191',
  ticket: '\u25A3',
};

const URGENCY_ACCENT = {
  needs_attention: 'bg-error/10',
  in_flight: 'bg-info/10',
  fyi: 'bg-success/10',
};

function timeAgo(min) {
  if (min == null || !Number.isFinite(min)) return '\u2014';
  if (min < 1) return 'now';
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}

export function SignalRow({ signal, onSelect, onPrioritySet, isSelected }) {
  const edge = PRIORITY_EDGE[signal.priority] || 'border-l-transparent';
  const icon = TYPE_ICONS[signal.signal_type] || '\u00B7';
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
            <span className="text-[10px]" title="Has screenshot">{'\uD83D\uDCF7'}</span>
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
