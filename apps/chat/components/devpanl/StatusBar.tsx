"use client";

export type UsageSnapshot = {
  session: { tokens: number; cost_usd: number };
  last24h: { tokens: number; cost_usd: number };
  provider?: string;
};

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function fmtCost(n: number) {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

export function StatusBar({ usage }: { usage: UsageSnapshot }) {
  return (
    <div className="flex h-6 items-center justify-between gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 font-mono text-[10.5px] text-[var(--color-foreground-muted)]">
      <div className="flex items-center gap-3">
        <span>
          <span className="text-[var(--color-foreground-faint)]">session</span>{" "}
          {fmtCost(usage.session.cost_usd)} · {fmtTokens(usage.session.tokens)} tok
        </span>
        <span className="text-[var(--color-border)]">|</span>
        <span>
          <span className="text-[var(--color-foreground-faint)]">24h</span>{" "}
          {fmtCost(usage.last24h.cost_usd)} · {fmtTokens(usage.last24h.tokens)} tok
        </span>
      </div>
      {usage.provider && (
        <span className="text-[var(--color-foreground-faint)]">{usage.provider}</span>
      )}
    </div>
  );
}
