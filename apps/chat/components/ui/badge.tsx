import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-mono tabular-nums uppercase tracking-wide transition-colors",
  {
    variants: {
      tone: {
        neutral:
          "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-foreground-muted)]",
        success:
          "border-[var(--color-success-border)] bg-[var(--color-success-soft)] text-[var(--color-success)]",
        warning:
          "border-[var(--color-warning-border)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
        error:
          "border-[var(--color-error-border)] bg-[var(--color-error-soft)] text-[var(--color-error)]",
        info:
          "border-[var(--color-info-border)] bg-[var(--color-info-soft)] text-[var(--color-info)]",
        brand:
          "border-[var(--color-brand-border)] bg-[var(--color-brand-soft)] text-[var(--color-brand)]",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { badgeVariants };
