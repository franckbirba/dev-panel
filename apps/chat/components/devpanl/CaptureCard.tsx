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

export function CaptureCard({
  capture,
  onAction,
}: {
  capture: Capture;
  onAction?: (action: "approve" | "defer" | "promote", id: string) => void;
}) {
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
        <p className="text-[12.5px] leading-relaxed text-[var(--color-foreground)] line-clamp-3">
          {capture.content}
        </p>
        {capture.screenshot_url && (
          <button
            className="block overflow-hidden rounded-md border border-[var(--color-border)] transition-opacity hover:opacity-80"
            type="button"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={capture.screenshot_url}
              alt="capture screenshot"
              className="max-h-32 w-full object-cover"
            />
          </button>
        )}
        <div className="flex items-center justify-between font-mono text-[11px] text-[var(--color-foreground-faint)]">
          <span>{capture.reporter?.name ?? "anonymous"}</span>
          <span>{capture.created_at}</span>
        </div>
      </CardContent>
      {capture.status === "new" || capture.status === "triaging" ? (
        <CardFooter className="gap-2 border-t border-[var(--color-border-subtle)] pt-3">
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
        </CardFooter>
      ) : null}
    </Card>
  );
}
