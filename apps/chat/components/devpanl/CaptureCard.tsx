"use client";

import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "./StatusBadge";

export type Capture = {
  id: string;
  project_name: string;
  kind: "bug" | "idea";
  status: "new" | "triaging" | "promoted" | "dropped";
  content: string;
  screenshot_url?: string;
  reporter?: { name: string };
  created_at: string;
};

const KIND_TONE = { bug: "error", idea: "info" } as const;

export type CaptureAction = "approve" | "defer" | "promote" | "talk";

export function CaptureCard({
  capture,
  onAction,
}: {
  capture: Capture;
  onAction?: (action: CaptureAction, id: string) => void;
}) {
  const isActionable =
    capture.status === "new" || capture.status === "triaging";

  return (
    <Card className="w-full overflow-hidden">
      <CardHeader className="bg-[var(--color-surface-2)]/30 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Badge tone="brand" className="px-1.5 py-0 font-bold">{capture.project_name}</Badge>
            <Badge tone={KIND_TONE[capture.kind]} className="px-1.5 py-0">{capture.kind}</Badge>
          </div>
          <StatusBadge status={capture.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-[var(--color-foreground)]">
          {capture.content}
        </pre>
        {capture.screenshot_url && (
          <div className="group relative">
            <a
              href={capture.screenshot_url}
              target="_blank"
              rel="noopener noreferrer"
              className="block overflow-hidden rounded-lg border border-[var(--color-border-subtle)] bg-black/40 p-1 transition-all hover:border-[var(--color-brand-border)] hover:bg-black/60"
              aria-label="Open screenshot full size in a new tab"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={capture.screenshot_url}
                alt="capture screenshot"
                className="max-h-80 w-full rounded-md object-contain"
              />
            </a>
          </div>
        )}
        <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-tighter text-[var(--color-foreground-faint)]">
          <div className="flex items-center gap-1.5">
            <span className="size-1 rounded-full bg-[var(--color-foreground-faint)]" />
            <span>{capture.reporter?.name ?? "anonymous"}</span>
          </div>
          <span>{capture.created_at}</span>
        </div>
      </CardContent>
      <CardFooter className="gap-2 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-2)]/10 py-2">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-3 font-mono text-[10px] uppercase tracking-wider hover:bg-[var(--color-surface-3)]"
          onClick={() => onAction?.("talk", capture.id)}
        >
          Talk
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {isActionable && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-3 font-mono text-[10px] uppercase tracking-wider hover:bg-[var(--color-surface-3)] hover:text-[var(--color-error)]"
                onClick={() => onAction?.("defer", capture.id)}
              >
                Defer
              </Button>
              <Button
                size="sm"
                className="h-7 bg-[var(--color-brand)] px-4 font-mono text-[10px] uppercase tracking-widest text-white shadow-[0_0_15px_rgba(124,92,255,0.3)] hover:bg-[var(--color-brand-hover)]"
                onClick={() => onAction?.("promote", capture.id)}
              >
                Promote
              </Button>
            </>
          )}
        </div>
      </CardFooter>
    </Card>
  );
}
