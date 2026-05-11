"use client";

// Inline action chips, structured-payload variant.
//
// MessageChips.tsx reads a markdown ```chips fence Shelly emits at the end
// of a turn. This card is the same contract but driven by a structured
// tool-call payload — used by ErrorHaltCard, QueueCard, and any future
// surface that already speaks the InlineActionChip shape.

import { Button } from "@/components/ui/button";
import { useThreadRuntime } from "@assistant-ui/react";
import type { InlineActionChip } from "@/lib/chat-renderer-types";

const VARIANT_CLASS: Record<NonNullable<InlineActionChip["variant"]>, string> = {
  default: "",
  primary:
    "border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-[var(--color-brand)] hover:bg-[var(--color-brand)]/20",
  danger:
    "border-[var(--color-error)] bg-[var(--color-error)]/10 text-[var(--color-error)] hover:bg-[var(--color-error)]/20",
};

export function InlineActionsCard({
  prompt,
  actions,
  onAction,
}: {
  prompt?: string;
  actions: InlineActionChip[];
  onAction?: (chip: InlineActionChip) => void;
}) {
  const runtime = useThreadRuntime();

  function defaultSend(chip: InlineActionChip) {
    runtime.append({
      role: "user",
      content: [{ type: "text", text: chip.payload ?? chip.label }],
    });
  }

  return (
    <div className="my-2 flex flex-col gap-2">
      {prompt && (
        <p className="text-[12.5px] text-[var(--color-foreground-muted)]">
          {prompt}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {actions.slice(0, 4).map((chip) => (
          <Button
            key={chip.id}
            type="button"
            variant="outline"
            size="sm"
            className={`h-7 px-3 text-[12px] ${
              VARIANT_CLASS[chip.variant ?? "default"]
            }`}
            onClick={() => (onAction ? onAction(chip) : defaultSend(chip))}
          >
            {chip.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
