import { StatusChip } from "./status-chip";

export function TicketRow({ ticket, selected, onClick, selectable, checked, onCheck }) {
  const context = typeof ticket.context === "string"
    ? JSON.parse(ticket.context || "{}")
    : ticket.context || {};
  const priority = context.priority || "medium";
  const priorityColors = { low: "bg-info", medium: "bg-warning", high: "bg-error", critical: "bg-error" };

  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 w-full px-3 py-3 rounded-lg text-left cursor-pointer transition-colors ${
        selected
          ? "bg-secondary border border-border"
          : "bg-transparent border border-transparent hover:bg-secondary/50"
      }`}
    >
      {selectable && (
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => { e.stopPropagation(); onCheck(ticket.id); }}
          onClick={(e) => e.stopPropagation()}
          className="w-3.5 h-3.5 rounded border-border accent-info cursor-pointer shrink-0"
        />
      )}
      <span className="text-muted-foreground/50 text-[10px] font-mono min-w-[50px] tabular-nums">
        DP-{String(ticket.id).padStart(4, "0")}
      </span>
      <StatusChip type={ticket.type} />
      <span className="flex-1 text-foreground text-[13px] font-medium truncate">
        {ticket.title}
      </span>
      <span className={`w-1.5 h-1.5 rounded-full ${priorityColors[priority] || "bg-warning"} shrink-0`} />
      <span className="text-muted-foreground/40 text-[10px] font-mono min-w-[44px] text-right tabular-nums">
        {new Date(ticket.created_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })}
      </span>
    </button>
  );
}
