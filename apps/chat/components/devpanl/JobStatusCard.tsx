"use client";

import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { JobStatusPayload, JobState } from "@/lib/chat-renderer-types";

const STATE_TONE: Record<
  JobState,
  "neutral" | "success" | "warning" | "error" | "info" | "brand"
> = {
  queued: "neutral",
  running: "warning",
  success: "success",
  failed: "error",
  blocked: "error",
  cancelled: "neutral",
};

export function JobStatusCard({ job }: { job: JobStatusPayload }) {
  const tone = STATE_TONE[job.state];
  const showProgress =
    typeof job.progress === "number" &&
    (job.state === "running" || job.state === "queued");

  return (
    <Card className="w-full border-l-2" style={{ borderLeftColor: `var(--color-${tone})` }}>
      <CardHeader className="flex-row items-center justify-between gap-2 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-bold tracking-tight">{job.name}</span>
          <span className="font-mono text-[10px] uppercase tracking-tighter text-[var(--color-foreground-faint)]">
            ID: {job.job_id}
          </span>
        </div>
        <Badge tone={tone} className="px-2 py-0">{job.state}</Badge>
      </CardHeader>
      <CardContent className="space-y-3 pb-3 pt-0">
        {showProgress && (
          <div className="flex items-center gap-2.5">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
              <div
                className={`h-full bg-[var(--color-${tone})] shadow-[0_0_8px_var(--color-${tone})] transition-[width] duration-500`}
                style={{ width: `${Math.max(0, Math.min(100, job.progress!))}%` }}
              />
            </div>
            <span className="font-mono text-[10px] font-bold text-[var(--color-foreground-muted)]">
              {Math.round(job.progress!)}%
            </span>
          </div>
        )}
        {job.detail && (
          <p className="font-sans text-[12px] leading-relaxed text-[var(--color-foreground-muted)]">
            {job.detail}
          </p>
        )}
        {job.updated_at && (
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-tighter text-[var(--color-foreground-faint)]">
            <span className="size-1 rounded-full bg-[var(--color-foreground-faint)]" />
            <span>Updated {job.updated_at}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
