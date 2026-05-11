"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import type {
  ConsoleStreamPayload,
  ConsoleStreamLine,
  Severity,
} from "@/lib/chat-renderer-types";

const SEVERITY_COLOR: Record<Severity, string> = {
  trace: "text-[var(--color-foreground-faint)]",
  info: "text-[var(--color-foreground)]",
  warn: "text-[var(--color-warning)]",
  error: "text-[var(--color-error)]",
  sync: "text-[var(--color-brand)]",
};

const STATE_DOT: Record<NonNullable<ConsoleStreamPayload["state"]>, string> = {
  connecting: "bg-[var(--color-warning)]",
  connected: "bg-[var(--color-success)]",
  reconnecting: "bg-[var(--color-warning)]",
  disconnected: "bg-[var(--color-error)]",
};

function formatLine(line: ConsoleStreamLine): {
  prefix: string;
  text: string;
  cls: string;
} {
  const sev = line.severity ?? "info";
  const tag = line.severity
    ? `[${line.severity.toUpperCase()}]`
    : "";
  const ts = line.ts ? line.ts.split("T")[1]?.replace("Z", "") ?? line.ts : "";
  const prefix = [ts, tag].filter(Boolean).join(" ");
  return { prefix, text: line.text, cls: SEVERITY_COLOR[sev] };
}

export function ConsoleStreamCard({ stream }: { stream: ConsoleStreamPayload }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const state = stream.state ?? "connected";

  useEffect(() => {
    if (stickToBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [stream.lines, stickToBottom]);

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
            className={`size-2 rounded-full ${STATE_DOT[state]}`}
            aria-label={state}
          />
          <span className="text-[12.5px] font-semibold">{stream.title}</span>
        </div>
        <span className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
          {state}
        </span>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed"
        >
          {stream.lines.map((line, i) => {
            const { prefix, text, cls } = formatLine(line);
            return (
              <pre key={i} className={`whitespace-pre-wrap break-words ${cls}`}>
                {prefix ? (
                  <span className="text-[var(--color-foreground-faint)]">
                    {prefix}{" "}
                  </span>
                ) : null}
                {text}
              </pre>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
