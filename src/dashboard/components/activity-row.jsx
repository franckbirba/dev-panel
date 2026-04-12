import { StatusChip } from "./status-chip";

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function ActivityRow({ activity }) {
  return (
    <div className="flex items-center gap-3 py-3 border-b border-border/30 last:border-0 group">
      <StatusChip type={activity.action} />
      <div className="flex-1 flex flex-col gap-0.5 min-w-0">
        <span className="text-foreground text-[13px] font-medium truncate">{activity.action}</span>
        <span className="text-muted-foreground/70 text-[11px] font-mono truncate">
          {activity.detail || `Ticket #${activity.ticket_id}`}
        </span>
      </div>
      <span className="text-muted-foreground/40 text-[10px] font-mono tabular-nums shrink-0 group-hover:text-muted-foreground transition-colors">
        {timeAgo(activity.created_at)}
      </span>
    </div>
  );
}
