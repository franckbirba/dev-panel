import { useState, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MetricCard } from "@/components/metric-card";
import { ActivityRow } from "@/components/activity-row";
import { QueueSummary } from "@/components/queue-summary";

function ProjectRow({ name, tickets, status }) {
  return (
    <div className="flex items-center gap-3 py-3 border-b border-border/50 last:border-0">
      <span className={`w-2 h-2 rounded-full ${status === "active" ? "bg-success" : "bg-warning"}`} />
      <span className="flex-1 text-foreground text-[13px] font-mono font-medium">{name}</span>
      <span className="text-muted-foreground text-[11px] font-mono">{tickets} tickets</span>
    </div>
  );
}

function SectionHeader({ title, children }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <h3 className="text-foreground text-[13px] font-semibold tracking-wide uppercase">{title}</h3>
      <div className="flex-1 h-px bg-border/50" />
      {children}
    </div>
  );
}

export function DashboardView({ apiUrl, apiKey, activities, refreshKey, queueHealth }) {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    fetch(`${apiUrl}/api/stats`, { headers: { "X-API-Key": apiKey } })
      .then((r) => (r.ok ? r.json() : null))
      .then(setStats)
      .catch(() => {});
  }, [apiUrl, apiKey, refreshKey]);

  const s = stats?.stats || {};
  const total = s.total || 0;
  const published = s.published || 0;

  return (
    <ScrollArea className="flex-1">
      <div className="flex flex-col gap-6 p-6 max-w-[1400px] mx-auto">
        {/* Metrics */}
        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Total Tickets" value={String(total)} delta="all time" />
          <MetricCard label="Pending" value={String(s.pending || 0)} delta="to review" />
          <MetricCard label="Published" value={String(published)} delta="on GitHub" />
          <MetricCard label="Rejected" value={String(s.rejected || 0)} delta="closed" />
        </div>

        {/* Two-column layout */}
        <div className="grid grid-cols-5 gap-6">
          {/* Activity — wider */}
          <div className="col-span-3 card-glow rounded-xl p-5">
            <SectionHeader title="Recent Activity" />
            {activities.length === 0 ? (
              <div className="empty-state flex items-center justify-center py-12 rounded-lg">
                <span className="text-muted-foreground/50 text-xs font-mono">No activity yet</span>
              </div>
            ) : (
              <div className="flex flex-col">
                {activities.map((a, i) => <ActivityRow key={a.id || i} activity={a} />)}
              </div>
            )}
          </div>

          {/* Right sidebar */}
          <div className="col-span-2 flex flex-col gap-6">
            {/* Projects */}
            <div className="card-glow rounded-xl p-5">
              <SectionHeader title="Projects" />
              <ProjectRow name={stats?.project || "dev-panel"} tickets={total} status="active" />
            </div>

            {/* GitHub Sync */}
            <div className="card-glow rounded-xl p-5 flex flex-col gap-4">
              <div className="flex items-center gap-2.5">
                <h3 className="flex-1 text-[13px] font-semibold tracking-wide uppercase">GitHub Sync</h3>
                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-success/10 text-success text-[10px] font-mono font-bold">
                  <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                  Connected
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-secondary/50 rounded-lg p-4 text-center">
                  <div className="text-foreground text-2xl font-bold">{published}</div>
                  <div className="text-muted-foreground text-[10px] font-mono mt-1">Published</div>
                </div>
                <div className="bg-secondary/50 rounded-lg p-4 text-center">
                  <div className="text-foreground text-2xl font-bold">{s.pending || 0}</div>
                  <div className="text-muted-foreground text-[10px] font-mono mt-1">Pending</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Queue summary */}
        <QueueSummary queueHealth={queueHealth} />
      </div>
    </ScrollArea>
  );
}
