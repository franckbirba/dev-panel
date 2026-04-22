// src/dashboard/views/today-view.jsx
// Operational digest. 4-cell metric strip + 4 sections, dense, scannable.
import { useState, useEffect, useCallback } from 'react';
import {
  IconExhausted, IconNeedsInput, IconRunning, IconFinished,
  IconFailed, IconDeploy,
} from '@/components/icons';

const POLL_MS = 12_000;

function timeAgo(min) {
  if (min == null || !Number.isFinite(min)) return '—';
  if (min < 1)    return 'now';
  if (min < 60)   return `${min}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}

function PageHeader({ title, subtitle, right }) {
  return (
    <div className="flex items-center gap-3 px-6 h-14 border-b border-[var(--color-border-subtle)] shrink-0">
      <h1 className="text-[15px] font-semibold tracking-tight text-[var(--color-foreground)]">{title}</h1>
      {subtitle && <span className="text-[12px] text-[var(--color-foreground-faint)]">{subtitle}</span>}
      <div className="flex-1" />
      {right}
    </div>
  );
}

function MetricStrip({ stats }) {
  const items = [
    { label: 'Ships (24h)',    value: stats?.ships ?? 0,             tone: 'success' },
    { label: 'In progress',    value: stats?.in_progress ?? 0,       tone: 'info'    },
    { label: 'Needs attention', value: stats?.needs_attention ?? 0,  tone: stats?.needs_attention > 0 ? 'warning' : 'muted' },
    { label: 'Avg duration',   value: stats?.avg_duration_min ? `${stats.avg_duration_min}m` : '—', tone: 'muted' },
  ];
  const TONE = {
    success: 'var(--color-success)',
    info:    'var(--color-info)',
    warning: 'var(--color-warning)',
    muted:   'var(--color-foreground)',
  };
  return (
    <div className="metric-strip" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map(it => (
        <div className="metric-cell" key={it.label}>
          <span className="label">{it.label}</span>
          <span className="value" style={{ color: TONE[it.tone] }}>{it.value}</span>
        </div>
      ))}
    </div>
  );
}

const ICON_TONE = {
  attention: { bg: 'var(--color-error-soft)',   fg: 'var(--color-error)'   },
  warning:   { bg: 'var(--color-warning-soft)', fg: 'var(--color-warning)' },
  info:      { bg: 'var(--color-info-soft)',    fg: 'var(--color-info)'    },
  success:   { bg: 'var(--color-success-soft)', fg: 'var(--color-success)' },
  muted:     { bg: 'var(--color-surface-2)',    fg: 'var(--color-foreground-muted)' },
};

function FeedRow({ icon: Icon, tone = 'muted', title, subtitle, age }) {
  const t = ICON_TONE[tone];
  return (
    <div className="flex items-center gap-3 px-4 h-11 hover:bg-[var(--color-surface-2)] transition-colors">
      <span
        className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
        style={{ background: t.bg, color: t.fg }}
      >
        <Icon width={13} height={13} />
      </span>
      <div className="flex-1 min-w-0 flex items-baseline gap-2">
        <span className="text-[13px] truncate text-[var(--color-foreground)]">{title}</span>
        {subtitle && <span className="text-[11px] text-[var(--color-foreground-faint)] font-mono truncate">{subtitle}</span>}
      </div>
      <span className="text-[11px] text-[var(--color-foreground-faint)] tabular-nums font-mono shrink-0">{age}</span>
    </div>
  );
}

function Section({ title, count, children, empty, tone = 'muted' }) {
  const dotColor = ICON_TONE[tone]?.fg || 'var(--color-foreground-muted)';
  const isEmpty = !children?.length;
  return (
    <div className="surface overflow-hidden animate-fade-in-up">
      <div className="flex items-center gap-2 px-4 h-9 border-b border-[var(--color-border-subtle)]">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: dotColor }} />
        <span className="text-[11px] uppercase tracking-wider font-semibold text-[var(--color-foreground-muted)]">{title}</span>
        {count != null && (
          <span className="text-[11px] text-[var(--color-foreground-faint)] tabular-nums font-mono">{count}</span>
        )}
      </div>
      <div className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
        {isEmpty ? (
          <div className="px-4 py-6 text-[12px] text-[var(--color-foreground-faint)] text-center">{empty}</div>
        ) : children}
      </div>
    </div>
  );
}

const IconDot = (props) => (
  <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor" {...props}>
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export function TodayView({ apiUrl, apiKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!apiKey) return;
    try {
      const r = await fetch(`${apiUrl}/api/today`, { headers: { 'X-API-Key': apiKey } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
      setError(null);
    } catch (e) { setError(e.message); }
  }, [apiUrl, apiKey]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const stats = data?.stats_24h;

  const attentionRows = [
    ...(data?.needs_attention || []).map(w => (
      <FeedRow
        key={`w-${w.instance_id}`}
        icon={w.kind === 'workflow_exhausted' ? IconExhausted : IconNeedsInput}
        tone={w.kind === 'workflow_exhausted' ? 'attention' : 'warning'}
        title={`${w.workflow}/${w.step} — rev ${w.revision}`}
        subtitle={`${w.work_item_id?.slice(0, 8) || '?'} · ${w.kind.replace('workflow_', '')}`}
        age={timeAgo(w.age_min)}
      />
    )),
    ...(data?.recent_failed_jobs || []).map(j => (
      <FeedRow
        key={`j-${j.job_id}`}
        icon={IconFailed}
        tone="attention"
        title={j.failed_reason || 'job failed (no reason)'}
        subtitle={`${j.agent || 'agent'} · job ${j.job_id} · ${j.attempts} attempt${j.attempts === 1 ? '' : 's'}`}
        age={timeAgo(j.age_min)}
      />
    )),
  ];

  const inProgressRows = (data?.in_progress || []).map(w => (
    <FeedRow
      key={`p-${w.instance_id}`}
      icon={IconRunning}
      tone="info"
      title={`${w.workflow} → ${w.step}`}
      subtitle={`${w.work_item_id?.slice(0, 8) || '?'} · rev ${w.revision}`}
      age={timeAgo(w.age_min)}
    />
  ));

  const shippedRows = (data?.shipped_today || []).map(w => (
    <FeedRow
      key={`s-${w.instance_id}`}
      icon={IconFinished}
      tone="success"
      title={`${w.workflow} shipped`}
      subtitle={w.work_item_id?.slice(0, 8) || '—'}
      age={timeAgo(w.age_min)}
    />
  ));

  const activityRows = (data?.activity || []).slice(0, 10).map((a, i) => (
    <FeedRow
      key={`a-${i}`}
      icon={IconDot}
      tone="muted"
      title={a.detail || a.action || 'activity'}
      subtitle={a.action}
      age={a.created_at ? timeAgo(Math.floor((Date.now() - new Date(a.created_at).getTime()) / 60000)) : '—'}
    />
  ));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Today"
        subtitle={data ? `on ${data.project.name}` : undefined}
        right={error && <span className="text-[11px] text-[var(--color-error)] font-mono">{error}</span>}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1100px] px-6 py-5 space-y-4">
          <MetricStrip stats={stats} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section title="Needs your attention" count={attentionRows.length} tone="attention" empty="Nothing waiting on you.">
              {attentionRows}
            </Section>
            <Section title="In progress" count={inProgressRows.length} tone="info" empty="No agents running right now.">
              {inProgressRows}
            </Section>
            <Section title="Shipped today" count={shippedRows.length} tone="success" empty="Nothing shipped yet today.">
              {shippedRows}
            </Section>
            <Section title="Recent activity" count={activityRows.length} tone="muted" empty="No recent activity.">
              {activityRows}
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
