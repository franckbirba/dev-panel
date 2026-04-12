import { Badge } from "@/components/ui/badge";

const chipStyles = {
  bug: "bg-error/10 text-error border-error/20",
  feature: "bg-info/10 text-info border-info/20",
  published: "bg-success/10 text-success border-success/20",
  rejected: "bg-muted text-muted-foreground border-border",
  pending: "bg-warning/10 text-warning border-warning/20",
  synced: "bg-warning/10 text-warning border-warning/20",
  created: "bg-info/10 text-info border-info/20",
  updated: "bg-muted text-muted-foreground border-border",
};

export function StatusChip({ label, type }) {
  return (
    <Badge variant="outline" className={`font-mono text-[10px] font-semibold tracking-wide rounded-md px-1.5 py-0 ${chipStyles[type] || chipStyles.pending}`}>
      {label || type}
    </Badge>
  );
}
