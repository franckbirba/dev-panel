import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { StatusBadge } from "./StatusBadge";

export type WorkItem = {
  sequence_id: number;
  project_short: string;
  name: string;
  state: string;
  priority: "urgent" | "high" | "medium" | "low" | "none";
  assignee?: { name: string; initials: string };
  cycle_progress?: { done: number; total: number };
  description?: string;
};

const PRIORITY_COLOR: Record<WorkItem["priority"], string> = {
  urgent: "text-[var(--color-error)]",
  high:   "text-[var(--color-warning)]",
  medium: "text-[var(--color-info)]",
  low:    "text-[var(--color-foreground-muted)]",
  none:   "text-[var(--color-foreground-faint)]",
};

export function WorkItemCard({ item }: { item: WorkItem }) {
  const id = `${item.project_short}-${item.sequence_id}`;
  const cycle = item.cycle_progress;
  const pct = cycle && cycle.total > 0
    ? Math.round((cycle.done / cycle.total) * 100)
    : null;

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] tabular-nums text-[var(--color-foreground-muted)]">
            {id}
          </span>
          <StatusBadge status={item.state} />
        </div>
        <h3 className="text-[14px] font-semibold leading-tight">{item.name}</h3>
      </CardHeader>
      <CardContent className="space-y-3">
        {item.description && (
          <p className="text-[12.5px] text-[var(--color-foreground-muted)] line-clamp-2">
            {item.description}
          </p>
        )}
        <div className="flex items-center gap-3 text-[11px] text-[var(--color-foreground-muted)]">
          <span className={`font-mono uppercase ${PRIORITY_COLOR[item.priority]}`}>
            {item.priority}
          </span>
          {item.assignee && (
            <div className="flex items-center gap-1.5">
              <Avatar className="size-5">
                <AvatarFallback className="text-[10px]">
                  {item.assignee.initials}
                </AvatarFallback>
              </Avatar>
              <span>{item.assignee.name}</span>
            </div>
          )}
        </div>
      </CardContent>
      {pct !== null && cycle && (
        <CardFooter className="border-t border-[var(--color-border-subtle)] pt-3">
          <div className="flex w-full items-center gap-2 text-[11px]">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
              <div
                className="h-full bg-[var(--color-brand)] transition-all"
                data-pct={pct}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="font-mono tabular-nums text-[var(--color-foreground-faint)]">
              {cycle.done}/{cycle.total}
            </span>
          </div>
        </CardFooter>
      )}
    </Card>
  );
}
