import { useState, useEffect, useCallback } from "react";

const POLL_MS = 12_000;

function timeAgo(min) {
  if (min == null || !Number.isFinite(min)) return "—";
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.floor(min/60)}h`;
  return `${Math.floor(min/1440)}d`;
}

function StatCard({ label, value, accent }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60">{label}</div>
      <div className={`mt-1 text-2xl tabular-nums font-mono ${accent || ''}`}>
        {value ?? "—"}
      </div>
    </div>
  );
}

function FeedRow({ icon, accent, title, subtitle, age, action }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-secondary/30 transition-colors">
      <div className={`w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-mono font-bold ${accent}`}>{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-xs truncate">{title}</div>
        {subtitle && <div className="text-[11px] text-muted-foreground truncate font-mono">{subtitle}</div>}
      </div>
      <div className="text-[11px] text-muted-foreground tabular-nums">{age}</div>
      {action}
    </div>
  );
}

function Section({ title, count, children, empty }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="px-4 py-2 bg-surface flex items-baseline gap-2 border-b border-border">
        <h3 className="text-[11px] uppercase tracking-wider font-medium">{title}</h3>
        {count != null && <span className="text-[10px] text-muted-foreground tabular-nums">{count}</span>}
      </div>
      <div className="divide-y divide-border">
        {children?.length ? children : (
          <div className="px-4 py-6 text-xs text-muted-foreground text-center">{empty}</div>
        )}
      </div>
    </div>
  );
}

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

  // Build the rows for each section.
  const attentionRows = [
    ...(data?.needs_attention || []).map(w => (
      <FeedRow
        key={`w-${w.instance_id}`}
        icon={w.kind === 'workflow_exhausted' ? '✗' : '?'}
        accent={w.kind === 'workflow_exhausted' ? 'bg-error/15 text-error' : 'bg-warning/15 text-warning'}
        title={`${w.workflow}/${w.step} — rev ${w.revision}`}
        subtitle={`${w.work_item_id?.slice(0,8) || '?'} · ${w.kind.replace('workflow_', '')}`}
        age={timeAgo(w.age_min)}
      />
    )),
    ...(data?.recent_failed_jobs || []).map(j => (
      <FeedRow
        key={`j-${j.job_id}`}
        icon="!"
        accent="bg-error/15 text-error"
        title={j.failed_reason || 'job failed (no reason)'}
        subtitle={`${j.agent || 'agent'} · job ${j.job_id} · ${j.attempts} attempt${j.attempts === 1 ? '' : 's'}`}
        age={timeAgo(j.age_min)}
      />
    ))
  ];

  const inProgressRows = (data?.in_progress || []).map(w => (
    <FeedRow
      key={`p-${w.instance_id}`}
      icon="↻"
      accent="bg-info/15 text-info animate-pulse"
      title={`${w.workflow} → ${w.step}`}
      subtitle={`${w.work_item_id?.slice(0,8) || '?'} · rev ${w.revision}`}
      age={timeAgo(w.age_min)}
    />
  ));

  const shippedRows = (data?.shipped_today || []).map(w => (
    <FeedRow
      key={`s-${w.instance_id}`}
      icon="✓"
      accent="bg-success/15 text-success"
      title={`${w.workflow} shipped`}
      subtitle={w.work_item_id?.slice(0,8) || '—'}
      age={timeAgo(w.age_min)}
    />
  ));

  const activityRows = (data?.activity || []).slice(0, 10).map((a, i) => (
    <FeedRow
      key={`a-${i}`}
      icon="·"
      accent="bg-secondary text-muted-foreground"
      title={a.detail || a.action || 'activity'}
      subtitle={a.action}
      age={a.created_at ? timeAgo(Math.floor((Date.now() - new Date(a.created_at).getTime()) / 60000)) : '—'}
    />
  ));

  return (
    <div className="h-full overflow-auto p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-baseline gap-3">
        <h2 className="text-base font-semibold tracking-tight">Today</h2>
        {data && <span className="text-xs text-muted-foreground">on {data.project.name}</span>}
        <div className="flex-1" />
        {error && <span className="text-[11px] text-error">{error}</span>}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Ships (24h)" value={stats?.ships} accent="text-success" />
        <StatCard label="In progress" value={stats?.in_progress} accent="text-info" />
        <StatCard label="Needs attention" value={stats?.needs_attention} accent={stats?.needs_attention > 0 ? "text-warning" : ""} />
        <StatCard label="Avg duration" value={stats?.avg_duration_min ? `${stats.avg_duration_min}m` : "—"} />
      </div>

      <Section
        title="Needs your attention"
        count={attentionRows.length}
        empty="Nothing waiting on you. Either you're caught up or the team's still warming up."
      >
        {attentionRows}
      </Section>

      <Section
        title="In progress"
        count={inProgressRows.length}
        empty="No agents running right now."
      >
        {inProgressRows}
      </Section>

      <Section
        title="Shipped today"
        count={shippedRows.length}
        empty="Nothing shipped yet today."
      >
        {shippedRows}
      </Section>

      <Section
        title="Recent activity"
        count={activityRows.length}
        empty="No recent ticket activity for this project."
      >
        {activityRows}
      </Section>
    </div>
  );
}
