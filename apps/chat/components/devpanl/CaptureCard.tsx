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
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge tone="brand">{capture.project_name}</Badge>
            <Badge tone={KIND_TONE[capture.kind]}>{capture.kind}</Badge>
          </div>
          <StatusBadge status={capture.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Full content — no clamp, no modal. Triage needs the whole text in
            view, especially for multi-line bug reports like the EDMS captures. */}
        <pre className="whitespace-pre-wrap break-words font-sans text-[12.5px] leading-relaxed text-[var(--color-foreground)]">
          {capture.content}
        </pre>
        {capture.screenshot_url && (
          <a
            href={capture.screenshot_url}
            target="_blank"
            rel="noopener noreferrer"
            className="block overflow-hidden rounded-md border border-[var(--color-border)] transition-opacity hover:opacity-90"
            aria-label="Open screenshot full size in a new tab"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={capture.screenshot_url}
              alt="capture screenshot"
              className="max-h-80 w-full object-contain bg-black"
            />
          </a>
        )}
        <div className="flex items-center justify-between font-mono text-[11px] text-[var(--color-foreground-faint)]">
          <span>{capture.reporter?.name ?? "anonymous"}</span>
          <span>{capture.created_at}</span>
        </div>
      </CardContent>
      <CardFooter className="gap-2 border-t border-[var(--color-border-subtle)] pt-3">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[11px]"
          onClick={() => onAction?.("talk", capture.id)}
        >
          Talk about it
        </Button>
        {isActionable && (
          <>
            <Button
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => onAction?.("promote", capture.id)}
            >
              Promote
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={() => onAction?.("approve", capture.id)}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={() => onAction?.("defer", capture.id)}
            >
              Defer
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  );
}
