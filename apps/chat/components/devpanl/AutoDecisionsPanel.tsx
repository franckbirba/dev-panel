"use client";

// Boss-COS audit panel.
//
// Shows auto-decisions Shelly took without asking, freshest first. Each
// row has a "rollback" affordance — click flips the row in the DB and
// (in a follow-up turn) Shelly executes the inverse via the undo_hint.
//
// Source: GET /api/admin/auto-decisions?since=24h-ago
// Rollback: POST /api/admin/auto-decisions/:id/rollback
//
// Mounted top-right of the chat shell so Franck sees what's been happening
// behind his back the moment he opens the dashboard. Collapsible because
// most days you don't want to look — but on the days you do, it's there.

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export type AutoDecision = {
  id: number;
  project_id: string | null;
  kind: string;
  what: string;
  why: string | null;
  undo_hint: Record<string, unknown> | null;
  ts: string;
  rolled_back_at: string | null;
  rolled_back_by: string | null;
};

const KIND_LABEL: Record<string, string> = {
  drop_capture: "drop capture",
  mark_triaging: "triage",
  dispatch_nightly: "dispatch nightly",
  restart_service: "restart",
  cancel_overbudget: "cancel (over-budget)",
  patch_promoted: "patch promoted",
  minor_correction: "fix",
  misc: "auto",
};

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export function AutoDecisionsPanel() {
  const [open, setOpen] = useState(false);
  const [decisions, setDecisions] = useState<AutoDecision[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<number | null>(null);

  async function refresh() {
    try {
      const r = await fetch("/api/admin/auto-decisions", {
        credentials: "include",
      });
      if (!r.ok) {
        // Likely missing admin key on the SSO session — silently empty,
        // panel just stays closed showing 0.
        setDecisions([]);
        return;
      }
      const data = await r.json();
      setDecisions(data.decisions ?? []);
    } catch {
      setDecisions([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // Light polling — every 30s. The dashboard is one tab, the cost is nil.
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, []);

  async function rollback(id: number) {
    setPending(id);
    try {
      await fetch(`/api/admin/auto-decisions/${id}/rollback`, {
        method: "POST",
        credentials: "include",
      });
      await refresh();
    } finally {
      setPending(null);
    }
  }

  const count = decisions.length;

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-card)] text-[12px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[var(--color-muted)]"
      >
        <span className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="size-3.5 text-[var(--color-foreground-faint)]" />
          ) : (
            <ChevronRight className="size-3.5 text-[var(--color-foreground-faint)]" />
          )}
          <span className="font-medium">Décisions auto</span>
          <span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
            {loading ? "…" : `${count} (24h)`}
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-[var(--color-border)]">
          {count === 0 ? (
            <p className="px-3 py-3 text-[11.5px] text-[var(--color-foreground-muted)]">
              Rien d'auto-décidé sur les dernières 24h.
            </p>
          ) : (
            <ul className="max-h-80 overflow-auto">
              {decisions.map((d) => (
                <li
                  key={d.id}
                  className="border-b border-[var(--color-border)] px-3 py-2 last:border-0"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px]">{d.what}</p>
                      <p className="mt-0.5 font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
                        {KIND_LABEL[d.kind] ?? d.kind} · {relativeTime(d.ts)}
                        {d.why && (
                          <span className="ml-2 text-[var(--color-foreground-muted)]">
                            — {d.why}
                          </span>
                        )}
                      </p>
                    </div>
                    {d.undo_hint && !d.rolled_back_at && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 gap-1 px-2 text-[11px]"
                        onClick={() => rollback(d.id)}
                        disabled={pending === d.id}
                        title="Rollback this decision"
                      >
                        <Undo2 className="size-3" />
                        {pending === d.id ? "…" : "rollback"}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
