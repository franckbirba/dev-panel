// src/dashboard/components/signal-row.jsx
import { PriorityButtons } from './priority-buttons';
import {
  IconExhausted, IconNeedsInput, IconRunning, IconFinished,
  IconFailed, IconCapture, IconDeploy, IconDeployFailed, IconTicket, IconCamera,
} from './icons';

const PRIORITY_DOT = {
  now:   'var(--color-error)',
  today: 'var(--color-warning)',
  later: 'var(--color-foreground-faint)',
};

const TYPE_ICONS = {
  workflow_exhausted:    IconExhausted,
  workflow_needs_input:  IconNeedsInput,
  workflow_running:      IconRunning,
  workflow_finished:     IconFinished,
  failed_job:            IconFailed,
  capture:               IconCapture,
  deploy_failed:         IconDeployFailed,
  deploy_succeeded:      IconDeploy,
  ticket:                IconTicket,
};

const URGENCY_ICON = {
  needs_attention: { bg: 'var(--color-error-soft)',   fg: 'var(--color-error)'   },
  in_flight:       { bg: 'var(--color-info-soft)',    fg: 'var(--color-info)'    },
  fyi:             { bg: 'var(--color-success-soft)', fg: 'var(--color-success)' },
};

function timeAgo(min) {
  if (min == null || !Number.isFinite(min)) return '\u2014';
  if (min < 1)    return 'now';
  if (min < 60)   return `${Math.round(min)}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}

export function SignalRow({ signal, onSelect, onPrioritySet, isSelected }) {
  const Icon = TYPE_ICONS[signal.signal_type] || IconTicket;
  const tone = URGENCY_ICON[signal.urgency] || { bg: 'var(--color-surface-2)', fg: 'var(--color-foreground-muted)' };
  const priorityDot = PRIORITY_DOT[signal.priority];

  return (
    <button
      onClick={() => onSelect(signal)}
      className={`group w-full text-left flex items-center gap-3 px-4 h-11 transition-colors duration-100 cursor-pointer relative
        ${isSelected
          ? 'bg-[var(--color-surface-3)]'
          : 'hover:bg-[var(--color-surface-2)]'}`}
    >
      {/* Priority edge — 2px left bar */}
      <span
        className="absolute left-0 top-2 bottom-2 w-[2px] rounded-r"
        style={{ background: priorityDot || 'transparent' }}
      />

      <span
        className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
        style={{ background: tone.bg, color: tone.fg }}
      >
        <Icon width={13} height={13} />
      </span>

      <div className="flex-1 min-w-0 flex items-baseline gap-2">
        <span className="text-[13px] truncate text-[var(--color-foreground)]">{signal.title}</span>
        <span className="text-[11px] text-[var(--color-foreground-faint)] font-mono shrink-0">
          {signal.project_name || signal.project_id?.slice(0, 8)}
        </span>
        {signal.has_screenshot && (
          <IconCamera width={11} height={11} className="text-[var(--color-foreground-faint)] shrink-0" />
        )}
      </div>

      <span className="text-[11px] text-[var(--color-foreground-faint)] tabular-nums shrink-0 font-mono w-8 text-right">
        {timeAgo(signal.age_min)}
      </span>

      <span className="opacity-0 group-hover:opacity-100 transition-opacity">
        <PriorityButtons
          current={signal.priority}
          onSet={(p) => onPrioritySet(signal.subject_type, signal.subject_id, p)}
        />
      </span>
    </button>
  );
}
