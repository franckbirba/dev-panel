"use client";

import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InlineActionsCard } from "./InlineActionsCard";
import type { QueueCardPayload, QueueItem } from "@/lib/chat-renderer-types";

const STATE_TONE: Record<
  QueueItem["state"],
  "neutral" | "success" | "warning" | "error" | "info" | "brand"
> = {
  pending: "neutral",
  waiting_for_input: "warning",
  approved: "success",
  rejected: "error",
  expired: "error",
};

const STATE_LABEL: Record<QueueItem["state"], string> = {
  pending: "pending",
  waiting_for_input: "waiting",
  approved: "approved",
  rejected: "rejected",
  expired: "expired",
};

export function QueueCard({ queue }: { queue: QueueCardPayload }) {
  return (
    <Card className="w-full">
      <CardHeader className="flex-row items-center justify-between gap-2 py-2">
        <span className="text-[12.5px] font-semibold uppercase tracking-wide">
          {queue.title}
        </span>
        <span className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
          {queue.items.length} {queue.items.length === 1 ? "item" : "items"}
        </span>
      </CardHeader>
      <CardContent className="space-y-2 pb-3 pt-0">
        <ul className="flex flex-col gap-2">
          {queue.items.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-1 rounded-md border border-[var(--color-border)] p-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[12px]">
                  {item.label}
                </span>
                <Badge tone={STATE_TONE[item.state]}>
                  {STATE_LABEL[item.state]}
                </Badge>
              </div>
              {item.detail && (
                <p className="text-[11.5px] text-[var(--color-foreground-muted)]">
                  {item.detail}
                </p>
              )}
              {item.actions && item.actions.length > 0 && (
                <InlineActionsCard actions={item.actions} />
              )}
            </li>
          ))}
        </ul>
        {queue.footer && (
          <p className="text-[11px] text-[var(--color-foreground-faint)]">
            {queue.footer}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
