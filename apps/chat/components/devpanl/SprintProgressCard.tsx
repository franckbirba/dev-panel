import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { StatusBadge } from "./StatusBadge";

export type CycleProgress = {
  cycle_name: string;
  start_date: string;
  end_date: string;
  days_remaining: number;
  total: number;
  done: number;
  in_progress: number;
  backlog: number;
  blockers: number;
  work_items?: Array<{
    sequence_id: number;
    project_short: string;
    name: string;
    state: string;
  }>;
};

export function SprintProgressCard({ cycle }: { cycle: CycleProgress }) {
  const donePct = cycle.total > 0 ? (cycle.done / cycle.total) * 100 : 0;
  const inProgressPct =
    cycle.total > 0 ? (cycle.in_progress / cycle.total) * 100 : 0;
  const backlogPct = cycle.total > 0 ? (cycle.backlog / cycle.total) * 100 : 0;
  const completePct = cycle.total > 0 ? Math.round(donePct) : 0;

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-[14px] font-semibold">{cycle.cycle_name}</h3>
          <span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
            {cycle.days_remaining}d remaining
          </span>
        </div>
        <p className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
          {cycle.start_date} → {cycle.end_date}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stacked progress bar */}
        <div>
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]">
            <div
              className="h-full bg-[var(--color-success)]"
              style={{ width: `${donePct}%` }}
            />
            <div
              className="h-full bg-[var(--color-info)]"
              style={{ width: `${inProgressPct}%` }}
            />
            <div
              className="h-full bg-[var(--color-foreground-faint)] opacity-30"
              style={{ width: `${backlogPct}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between font-mono text-[11px] tabular-nums text-[var(--color-foreground-muted)]">
            <span>
              {cycle.done}/{cycle.total} done · {cycle.in_progress} in progress
              {cycle.blockers > 0 && (
                <span className="text-[var(--color-warning)]">
                  {" "}
                  · {cycle.blockers} blocked
                </span>
              )}
            </span>
            <span>{completePct}%</span>
          </div>
        </div>

        {cycle.work_items && cycle.work_items.length > 0 && (
          <ul className="divide-y divide-[var(--color-border-subtle)]">
            {cycle.work_items.map((wi) => (
              <li
                key={`${wi.project_short}-${wi.sequence_id}`}
                className="flex items-center justify-between gap-2 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="font-mono text-[11px] tabular-nums text-[var(--color-foreground-muted)]">
                    {wi.project_short}-{wi.sequence_id}
                  </span>
                  <span className="truncate text-[12.5px]">{wi.name}</span>
                </div>
                <StatusBadge status={wi.state} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
