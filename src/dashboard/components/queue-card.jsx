import { useState } from "react";
import { StatusChip } from "@/components/status-chip";
import { Badge } from "@/components/ui/badge";

const statusStyles = {
  healthy: "healthy",
  warning: "warning",
  critical: "bug",
  unreachable: "rejected",
};

const countEntries = [
  { key: "waiting", label: "Wait", color: "text-warning", barColor: "bg-warning" },
  { key: "active", label: "Active", color: "text-info", barColor: "bg-info" },
  { key: "delayed", label: "Delay", color: "text-muted-foreground", barColor: "bg-muted-foreground" },
  { key: "failed", label: "Fail", color: "text-error", barColor: "bg-error" },
  { key: "completed", label: "Done", color: "text-success", barColor: "bg-success" },
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
      // silently fail — next SSE update will show current state
    }
    setActing(false);
  }

  const hasActivity = (c.waiting || 0) + (c.active || 0) + (c.delayed || 0) + (c.failed || 0) > 0;
  const total = Object.values(c).reduce((sum, v) => sum + (v || 0), 0) || 1;

  return (
    <button
      onClick={() => onSelect(shortName)}
      className={`glass-card rounded-xl p-4 text-left cursor-pointer transition-all shrink-0 min-w-[220px] animate-fade-in-up ${
        selected ? "ring-2 ring-brand/50 shadow-lg shadow-brand/5" : "hover:ring-1 hover:ring-brand/20"
      }`}
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="text-foreground text-[13px] font-mono font-semibold truncate">{shortName}</span>
        <div className="flex-1" />
        <StatusChip type={statusStyles[queue.status] || "pending"} label={queue.status} />
        {queue.paused && (
          <Badge variant="outline" className="font-mono text-[10px] bg-warning/10 text-warning border-warning/20 px-1.5 py-0">
            PAUSED
          </Badge>
        )}
      </div>

      {/* Mini bar chart */}
      <div className="h-1.5 rounded-full bg-secondary/50 overflow-hidden flex mb-3">
        {countEntries.filter(({ key }) => c[key] > 0).map(({ key, barColor }) => (
          <div key={key} className={`${barColor} transition-all duration-500`}
            style={{ width: `${Math.max((c[key] / total) * 100, 2)}%` }} />
        ))}
      </div>

      <div className="flex gap-2">
        {countEntries.filter(({ key }) => hasActivity || key === "waiting" || key === "active" || key === "failed").map(({ key, label, color }) => (
          <div key={key} className="flex flex-col items-center rounded-lg py-1.5 px-2 min-w-[38px] bg-white/[0.02]">
            <span className={`text-sm font-bold tabular-nums ${color}`}>{c[key] || 0}</span>
            <span className="text-muted-foreground/40 text-[8px] font-mono mt-0.5">{label}</span>
          </div>
        ))}
      </div>
      {adminKey && (
        <div className="flex gap-3 mt-3 pt-3 border-t border-border/50" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => adminAction(queue.paused ? "resume" : "pause")}
            disabled={acting}
            className="text-[11px] font-mono text-muted-foreground/60 hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
          >
            {queue.paused ? "Resume" : "Pause"}
          </button>
          <button
            onClick={() => adminAction("clean")}
            disabled={acting}
            className="text-[11px] font-mono text-muted-foreground/60 hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
          >
            Clean done
          </button>
        </div>
      )}
    </button>
  );
}
