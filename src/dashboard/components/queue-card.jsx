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
  { key: "waiting", label: "Waiting", color: "text-warning" },
  { key: "active", label: "Active", color: "text-info" },
  { key: "delayed", label: "Delayed", color: "text-muted-foreground" },
  { key: "failed", label: "Failed", color: "text-error" },
  { key: "completed", label: "Done", color: "text-success" },
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

  return (
    <button
      onClick={() => onSelect(shortName)}
      className={`card-glow rounded-xl p-3 text-left cursor-pointer transition-all shrink-0 min-w-[200px] ${
        selected ? "ring-2 ring-ring/60" : "hover:ring-1 hover:ring-ring/30"
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-foreground text-[12px] font-mono font-semibold truncate">{shortName}</span>
        <div className="flex-1" />
        <StatusChip type={statusStyles[queue.status] || "pending"} label={queue.status} />
        {queue.paused && (
          <Badge variant="outline" className="font-mono text-[10px] bg-warning/10 text-warning border-warning/20 px-1.5 py-0">
            PAUSED
          </Badge>
        )}
      </div>
      <div className="flex gap-2">
        {countEntries.filter(({ key }) => hasActivity || key === "waiting" || key === "active" || key === "failed").map(({ key, label, color }) => (
          <div key={key} className="flex flex-col items-center bg-secondary/50 rounded-md py-1.5 px-2 min-w-[36px]">
            <span className={`text-sm font-bold ${color}`}>{c[key] || 0}</span>
            <span className="text-muted-foreground/60 text-[8px] font-mono">{label}</span>
          </div>
        ))}
      </div>
      {adminKey && (
        <div className="flex gap-2 mt-3 pt-3 border-t border-border/50" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => adminAction(queue.paused ? "resume" : "pause")}
            disabled={acting}
            className="text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
          >
            {queue.paused ? "Resume" : "Pause"}
          </button>
          <button
            onClick={() => adminAction("clean")}
            disabled={acting}
            className="text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
          >
            Clean done
          </button>
        </div>
      )}
    </button>
  );
}
