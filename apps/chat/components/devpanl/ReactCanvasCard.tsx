"use client";

// react-canvas — placeholder renderer.
//
// The live preview + sandbox compile path is DEVPA-220. This component
// ships the contract surface: header w/ filename + Preview/Code toggle,
// the code panel (always available), a stub preview pane that explains
// the live-render is on a follow-up ticket, slots + footer per spec.
//
// Why ship the contract now: capabilities can already emit react-canvas
// payloads (e.g. when Shelly suggests a TSX snippet) without crashing the
// dashboard or falling through to ToolFallback. DEVPA-220 swaps in the
// esbuild-wasm + iframe path behind the same component prop surface.

import { useState } from "react";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ReactCanvasPayload } from "@/lib/chat-renderer-types";

function formatBytes(n?: number): string | null {
  if (typeof n !== "number") return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function ReactCanvasCard({ canvas }: { canvas: ReactCanvasPayload }) {
  const [tab, setTab] = useState<"preview" | "code">("code");
  const size = formatBytes(canvas.bundle_size);

  return (
    <Card className="w-full">
      <CardHeader className="flex-row items-center justify-between gap-2 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[12.5px] font-semibold">
            {canvas.filename ?? "Canvas.tsx"}
          </span>
          <Badge tone="success">live sync</Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant={tab === "preview" ? "default" : "outline"}
            size="sm"
            className="h-7 px-3 text-[11.5px]"
            onClick={() => setTab("preview")}
          >
            Preview
          </Button>
          <Button
            type="button"
            variant={tab === "code" ? "default" : "outline"}
            size="sm"
            className="h-7 px-3 text-[11.5px]"
            onClick={() => setTab("code")}
          >
            Code
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pb-3 pt-0">
        {tab === "preview" ? (
          <div className="flex h-48 items-center justify-center rounded-md border border-dashed border-[var(--color-border)] text-[11.5px] text-[var(--color-foreground-muted)]">
            Live preview lands in DEVPA-220 (esbuild-wasm + sandbox iframe).
          </div>
        ) : (
          <pre className="max-h-64 overflow-auto rounded-md bg-[var(--color-card)]/40 p-2 font-mono text-[11px] leading-relaxed text-[var(--color-foreground-muted)]">
            {canvas.tsx}
          </pre>
        )}
        {canvas.slots && canvas.slots.length > 0 && (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {canvas.slots.map((slot, i) => (
              <div
                key={i}
                className="rounded-md border border-[var(--color-border)] p-2 text-[11px]"
              >
                <p className="font-semibold text-[var(--color-foreground)]">
                  {slot.title ?? slot.kind}
                </p>
                {slot.body && (
                  <p className="text-[var(--color-foreground-muted)]">
                    {slot.body}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="flex items-center gap-3 font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
          {size && <span>{size}</span>}
          {canvas.deps && canvas.deps.length > 0 && (
            <span>deps: {canvas.deps.join(", ")}</span>
          )}
        </p>
      </CardContent>
    </Card>
  );
}
