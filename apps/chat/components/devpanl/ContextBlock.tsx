"use client";

import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "./StatusBadge";

export type ProjectContext = {
  project_short: string;
  pipeline_status: "green" | "yellow" | "red";
  last_sync: string;
  loaded_plugins: string[];
  active_cycle?: string;
};

const PIPELINE_TONE = {
  green:  "success",
  yellow: "warning",
  red:    "error",
} as const;

export function ContextBlock({ ctx }: { ctx: ProjectContext }) {
  return (
    <Card className="mx-2 mb-2">
      <CardContent className="space-y-2 p-3">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-wide text-[var(--color-foreground-muted)]">
            Pipeline
          </span>
          <StatusBadge status={`pipeline_${ctx.pipeline_status}`} />
        </div>
        {ctx.active_cycle && (
          <div className="flex items-center justify-between text-[11.5px]">
            <span className="text-[var(--color-foreground-muted)]">Cycle</span>
            <span className="truncate font-mono">{ctx.active_cycle}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-[11.5px]">
          <span className="text-[var(--color-foreground-muted)]">Synced</span>
          <span className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
            {ctx.last_sync}
          </span>
        </div>
        {ctx.loaded_plugins.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {ctx.loaded_plugins.map((p) => (
              <span
                key={p}
                className="rounded-sm border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--color-foreground-muted)]"
              >
                {p}
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
