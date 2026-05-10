import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "./StatusBadge";

export type FleetRow = {
  job_id: string;
  agent: string;
  work_item_short: string;
  state: "queued" | "running" | "awaiting_approval" | "blocked" | "completed" | "failed";
  step?: string;
  duration_seconds?: number;
  tokens?: number;
  spend_usd?: number;
};

function fmtDuration(s: number) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

const ACTIONS_BY_STATE: Record<FleetRow["state"], string[]> = {
  queued: ["Tail", "Kill"],
  running: ["Tail", "Kill", "Pause"],
  awaiting_approval: ["Approve", "Reply", "Tail"],
  blocked: ["Reply", "Retry", "Tail"],
  completed: ["Tail"],
  failed: ["Retry", "Tail"],
};

export function FleetRowCard({
  row,
  onAction,
}: {
  row: FleetRow;
  onAction?: (action: string, jobId: string) => void;
}) {
  const actions = ACTIONS_BY_STATE[row.state] ?? [];

  return (
    <Card className="w-full">
      <CardContent className="flex items-center gap-3 p-3">
        <StatusBadge status={row.state} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold">{row.agent}</span>
            <span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
              {row.work_item_short}
            </span>
            {row.step && (
              <span className="text-[11px] text-[var(--color-foreground-faint)] truncate">
                · {row.step}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-3 font-mono text-[11px] tabular-nums text-[var(--color-foreground-muted)]">
            {row.duration_seconds !== undefined && (
              <span>{fmtDuration(row.duration_seconds)}</span>
            )}
            {row.tokens !== undefined && <span>{fmtTokens(row.tokens)} tok</span>}
            {row.spend_usd !== undefined && (
              <span>${row.spend_usd.toFixed(2)}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {actions.map((a) => (
            <Button
              key={a}
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={() => onAction?.(a, row.job_id)}
            >
              {a}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
