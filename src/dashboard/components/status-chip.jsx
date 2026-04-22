import { Badge } from "@/components/ui/badge";

const chipStyles = {
  bug: "bg-error/10 text-error border-error/15",
  feature: "bg-info/10 text-info border-info/15",
  published: "bg-success/10 text-success border-success/15",
  rejected: "bg-muted/40 text-muted-foreground border-border",
  pending: "bg-warning/10 text-warning border-warning/15",
  synced: "bg-warning/10 text-warning border-warning/15",
  created: "bg-info/10 text-info border-info/15",
  updated: "bg-muted/40 text-muted-foreground border-border",
  healthy: "bg-success/10 text-success border-success/15",
  warning: "bg-warning/10 text-warning border-warning/15",
};

export function StatusChip({ label, type }) {
  return (
    <Badge variant="outline" className={`font-mono text-[10px] font-semibold tracking-wide rounded-md px-1.5 py-0 ${chipStyles[type] || chipStyles.pending}`}>
      {label || type}
    </Badge>
  );
}
