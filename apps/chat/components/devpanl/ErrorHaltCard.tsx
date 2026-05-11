"use client";

import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InlineActionsCard } from "./InlineActionsCard";
import type { ErrorHaltPayload } from "@/lib/chat-renderer-types";

export function ErrorHaltCard({ halt }: { halt: ErrorHaltPayload }) {
  return (
    <Card className="w-full border-[var(--color-error)]/50">
      <CardHeader className="flex-row items-center justify-between gap-2 py-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[12.5px] font-semibold text-[var(--color-error)]">
            Execution halted
          </span>
          {halt.source && (
            <span className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
              {halt.source}
            </span>
          )}
        </div>
        <Badge tone="error">{halt.error_code}</Badge>
      </CardHeader>
      <CardContent className="space-y-2 pb-3 pt-0">
        <p className="text-[12.5px]">{halt.message}</p>
        {halt.recovery_prompt && (
          <p className="text-[12.5px] text-[var(--color-foreground-muted)]">
            {halt.recovery_prompt}
          </p>
        )}
        {halt.actions && halt.actions.length > 0 && (
          <InlineActionsCard actions={halt.actions} />
        )}
      </CardContent>
    </Card>
  );
}
