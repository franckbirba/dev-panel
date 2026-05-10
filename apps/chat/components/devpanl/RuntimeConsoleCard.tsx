"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, CardContent } from "@/components/ui/card";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

const DOT_COLOR: Record<ConnectionState, string> = {
  connecting:   "bg-[var(--color-warning)]",
  connected:    "bg-[var(--color-success)]",
  reconnecting: "bg-[var(--color-warning)]",
  disconnected: "bg-[var(--color-error)]",
};

export function RuntimeConsoleCard({
  title,
  lines,
  state = "connected",
}: {
  title: string;
  lines: string[];
  state?: ConnectionState;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  // Auto-scroll on new lines unless user scrolled up.
  useEffect(() => {
    if (stickToBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, stickToBottom]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
    setStickToBottom(atBottom);
  }

  return (
    <Card className="flex h-80 w-full flex-col">
      <CardHeader className="flex-row items-center justify-between gap-2 py-2">
        <div className="flex items-center gap-2">
          <span
            className={`size-2 rounded-full ${DOT_COLOR[state]}`}
            aria-label={state}
          />
          <span className="text-[12.5px] font-semibold">{title}</span>
        </div>
        <span className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
          {state}
        </span>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed text-[var(--color-foreground-muted)]"
        >
          {lines.map((line, i) => (
            <pre
              key={i}
              className="whitespace-pre-wrap break-words"
            >
              {line}
            </pre>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
