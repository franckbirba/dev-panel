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
    <Card className="w-full">
      <CardHeader className="flex-row items-center justify-between gap-2 py-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[12.5px] font-semibold">{job.name}</span>
          <span className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
            {job.job_id}
          </span>
        </div>
        <Badge tone={tone}>{job.state}</Badge>
      </CardHeader>
      <CardContent className="space-y-2 pb-3 pt-0">
        {showProgress && (
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-border)]">
              <div
                className="h-full bg-[var(--color-brand)] transition-[width] duration-500"
                style={{ width: `${Math.max(0, Math.min(100, job.progress!))}%` }}
              />
            </div>
            <span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
              {Math.round(job.progress!)}%
            </span>
          </div>
        )}
        {job.detail && (
          <p className="text-[11.5px] text-[var(--color-foreground-muted)]">
            {job.detail}
          </p>
        )}
        {job.updated_at && (
          <p className="font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
            updated {job.updated_at}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
