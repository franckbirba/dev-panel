import { StatusChip } from "@/components/status-chip";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";

const statusStyles = {
  healthy: "healthy",
  warning: "warning",
  critical: "bug",
  unreachable: "rejected",
};

function QueueMiniCard({ queue }) {
  const c = queue.counts || {};
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-border/50 last:border-0">
      <StatusChip type={statusStyles[queue.status] || "pending"} label={queue.status} />
      <span className="flex-1 text-foreground text-[13px] font-mono font-medium truncate">
        {queue.queue.replace("devpanel:", "")}
      </span>
      <div className="flex items-center gap-2">
        {c.active > 0 && (
          <Badge variant="outline" className="font-mono text-[10px] bg-info/10 text-info border-info/20 px-1.5 py-0">
            {c.active} active
          </Badge>
        )}
        {c.waiting > 0 && (
          <Badge variant="outline" className="font-mono text-[10px] bg-warning/10 text-warning border-warning/20 px-1.5 py-0">
            {c.waiting} waiting
          </Badge>
        )}
        {c.failed > 0 && (
          <Badge variant="outline" className="font-mono text-[10px] bg-error/10 text-error border-error/20 px-1.5 py-0">
            {c.failed} failed
          </Badge>
        )}
        {c.delayed > 0 && (
          <Badge variant="outline" className="font-mono text-[10px] bg-muted text-muted-foreground border-border px-1.5 py-0">
            {c.delayed} delayed
          </Badge>
        )}
      </div>
    </div>
  );
}

export function QueueSummary({ queueHealth }) {
  if (!queueHealth || queueHealth.status === "unreachable") {
    return (
      <div className="card-glow rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <h3 className="text-foreground text-[13px] font-semibold tracking-wide uppercase">Queues</h3>
          <div className="flex-1 h-px bg-border/50" />
          <span className="text-muted-foreground/40 text-[10px] font-mono">disconnected</span>
        </div>
        <div className="empty-state flex items-center justify-center py-8 rounded-lg">
          <span className="text-muted-foreground/50 text-xs font-mono">Redis unreachable</span>
        </div>
      </div>
    );
  }

  return (
    <div className="card-glow rounded-xl p-5">
      <div className="flex items-center gap-3 mb-4">
        <h3 className="text-foreground text-[13px] font-semibold tracking-wide uppercase">Queues</h3>
        <div className="flex-1 h-px bg-border/50" />
        <StatusChip type={statusStyles[queueHealth.status] || "pending"} label={queueHealth.status} />
        <Link to="/queues" className="text-info text-[11px] font-mono hover:underline cursor-pointer">
          Open full view →
        </Link>
      </div>
      <div className="flex flex-col">
        {(queueHealth.queues || []).map((q) => (
          <QueueMiniCard key={q.queue} queue={q} />
        ))}
      </div>
    </div>
  );
}
