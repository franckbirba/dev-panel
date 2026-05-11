"use client";

import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { TerminalSessionPayload } from "@/lib/chat-renderer-types";

const SECURITY_TONE = {
  ok: "success",
  warn: "warning",
  danger: "error",
} as const;

export function TerminalSessionCard({
  session,
}: {
  session: TerminalSessionPayload;
}) {
  return (
    <Card className="w-full">
      <CardHeader className="flex-row items-center justify-between gap-2 py-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[12.5px] font-semibold">
            {session.user ? `${session.user}@${session.host}` : session.host}
          </span>
          <span className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
            {session.session_id}
          </span>
        </div>
        <Badge tone="success">live</Badge>
      </CardHeader>
      <CardContent className="grid gap-3 pb-3 pt-0 md:grid-cols-[2fr_1fr]">
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-card)]/40 p-2 font-mono text-[11px] text-[var(--color-foreground-muted)]">
          {(session.initial_lines ?? []).join("\n")}
          {session.prompt ? `\n${session.prompt}$ ` : ""}
        </pre>
        <aside className="flex flex-col gap-2 text-[11px]">
          {session.metrics && (
            <div className="rounded-md border border-[var(--color-border)] p-2">
              <p className="mb-1 text-[10.5px] uppercase tracking-wide text-[var(--color-foreground-faint)]">
                host metrics
              </p>
              {session.metrics.load && (
                <p className="font-mono">
                  load {session.metrics.load.join(" / ")}
                </p>
              )}
              {session.metrics.memory_used && session.metrics.memory_total && (
                <p className="font-mono">
                  mem {session.metrics.memory_used} /{" "}
                  {session.metrics.memory_total}
                </p>
              )}
            </div>
          )}
          {session.security && session.security.length > 0 && (
            <div className="rounded-md border border-[var(--color-border)] p-2">
              <p className="mb-1 text-[10.5px] uppercase tracking-wide text-[var(--color-foreground-faint)]">
                security
              </p>
              <ul className="flex flex-col gap-1">
                {session.security.map((s, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <Badge tone={SECURITY_TONE[s.variant ?? "ok"]}>
                      {s.label}
                    </Badge>
                    {s.detail && (
                      <span className="text-[var(--color-foreground-muted)]">
                        {s.detail}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </CardContent>
    </Card>
  );
}
