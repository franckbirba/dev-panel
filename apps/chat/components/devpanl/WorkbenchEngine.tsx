"use client";

import { useEffect, useState } from "react";
import { Cpu, AlertCircle, Rocket, Terminal } from "lucide-react";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type QueueHealth = {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
};

type HealthResponse = {
  status: string;
  timestamp?: string;
  queues?: QueueHealth[];
  error?: string;
};

type FleetAgent = {
  id: string;
  workflow_name: string;
  current_step?: string;
  status: string;
  work_item_id?: string;
  plane_sequence?: string;
  plane_project_name?: string;
  last_event_at?: string;
  last_job_id?: string;
  last_step?: { step?: string; agent?: string; status?: string };
};

type FleetResponse = {
  agents: FleetAgent[];
  degraded?: boolean;
  error?: string;
};

export function WorkbenchEngine({
  onTailAgent,
}: {
  onTailAgent?: (jobId: string) => void;
} = {}) {
  const [queues, setQueues] = useState<HealthResponse | null>(null);
  const [fleet, setFleet] = useState<FleetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchBoth() {
      try {
        const [qr, fr] = await Promise.all([
          fetch("api/health/queues", { credentials: "include" }),
          fetch("api/fleet?status=active", { credentials: "include" }),
        ]);
        if (cancelled) return;

        const qJson: HealthResponse = qr.ok
          ? await qr.json()
          : { status: "unknown", queues: [], error: `${qr.status} ${qr.statusText}` };
        const fJson: FleetResponse = fr.ok
          ? await fr.json()
          : { agents: [], error: `${fr.status} ${fr.statusText}` };

        if (cancelled) return;
        setQueues(qJson);
        setFleet(fJson);
        setError(null);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        setLoading(false);
      }
    }

    fetchBoth();
    const timer = setInterval(fetchBoth, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (loading && !queues && !fleet) {
    return (
      <div className="flex flex-1 items-center justify-center bg-[var(--color-background)]">
        <div className="flex flex-col items-center gap-4">
          <Cpu className="size-8 animate-pulse text-[var(--color-brand)]" />
          <p className="font-mono text-[11px] text-[var(--color-foreground-faint)] uppercase tracking-widest">
            Syncing Engine State...
          </p>
        </div>
      </div>
    );
  }

  const queueList = queues?.queues ?? [];
  const agents = fleet?.agents ?? [];

  return (
    <div className="flex flex-1 flex-col overflow-auto bg-[var(--color-background)] p-6">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-[18px] font-bold tracking-tight text-[var(--color-foreground)]">
            Engine & Active Agents
          </h2>
          <p className="text-[13px] text-[var(--color-foreground-muted)]">
            BullMQ queues · live workflow instances
          </p>
        </div>
        <Badge
          tone={
            queues?.status === "healthy"
              ? "success"
              : queues?.status === "critical"
              ? "error"
              : "warning"
          }
          className="px-3 py-1"
        >
          {queues?.status?.toUpperCase() || "UNKNOWN"}
        </Badge>
      </header>

      {error && (
        <div className="mb-4 rounded-md border border-[var(--color-error)] bg-[var(--color-error)]/10 px-4 py-2 font-mono text-[11px] text-[var(--color-error)]">
          {error}
        </div>
      )}

      <section className="mb-8">
        <h3 className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-[var(--color-foreground-muted)]">
          <Rocket className="size-3.5" /> Active Agents · {agents.length}
        </h3>
        {agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-[var(--color-border-subtle)] py-8">
            <AlertCircle className="mb-2 size-6 text-[var(--color-foreground-faint)]" />
            <p className="text-[13px] text-[var(--color-foreground-muted)]">
              No active workflow instances
            </p>
            {fleet?.degraded && (
              <p className="mt-1 font-mono text-[10px] text-[var(--color-foreground-faint)]">
                fleet endpoint degraded — {fleet.error || "no data"}
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {agents.map((a) => (
              <Card
                key={a.id}
                className="border-[var(--color-border-subtle)] bg-[var(--color-surface-1)]"
              >
                <CardHeader className="flex-row items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-2.5">
                  <div className="flex flex-col">
                    <span className="font-mono text-[12px] font-bold text-[var(--color-brand)]">
                      {a.workflow_name}
                    </span>
                    <span className="font-mono text-[10px] text-[var(--color-foreground-faint)]">
                      {a.plane_sequence || a.work_item_id?.slice(0, 8) || a.id.slice(0, 8)}
                      {a.plane_project_name ? ` · ${a.plane_project_name}` : ""}
                    </span>
                  </div>
                  <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                </CardHeader>
                <CardContent className="px-4 py-3">
                  <div className="flex flex-col gap-1 font-mono text-[11px]">
                    <span className="text-[var(--color-foreground)]">
                      step:{" "}
                      <span className="text-[var(--color-foreground-muted)]">
                        {a.current_step || a.last_step?.step || "—"}
                      </span>
                    </span>
                    {a.last_step?.agent && (
                      <span className="text-[var(--color-foreground)]">
                        agent:{" "}
                        <span className="text-[var(--color-foreground-muted)]">
                          {a.last_step.agent}
                        </span>
                      </span>
                    )}
                    {a.last_event_at && (
                      <span className="text-[var(--color-foreground-faint)]">
                        last: {new Date(a.last_event_at).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                  {onTailAgent && a.last_job_id && (
                    <button
                      type="button"
                      onClick={() => onTailAgent(a.last_job_id!)}
                      className="mt-3 flex items-center gap-1.5 rounded-md bg-[var(--color-brand-soft)] px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-[var(--color-brand)] hover:opacity-80 cursor-pointer"
                      title={`Tail job ${a.last_job_id}`}
                    >
                      <Terminal className="size-3" />
                      Tail logs
                    </button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-[var(--color-foreground-muted)]">
          <Cpu className="size-3.5" /> Queues · {queueList.length}
        </h3>
        {queueList.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-[var(--color-border-subtle)] py-8">
            <AlertCircle className="mb-2 size-6 text-[var(--color-foreground-faint)]" />
            <p className="text-[13px] text-[var(--color-foreground-muted)]">
              No queue data
            </p>
            {queues?.error && (
              <p className="mt-1 font-mono text-[10px] text-[var(--color-foreground-faint)]">
                {queues.error}
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {queueList.map((q) => (
              <Card
                key={q.name}
                className="border-[var(--color-border-subtle)] bg-[var(--color-surface-1)]"
              >
                <CardHeader className="flex-row items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-3">
                  <span className="font-mono text-[13px] font-bold uppercase text-[var(--color-brand)]">
                    {q.name}
                  </span>
                  {q.paused ? (
                    <Badge tone="error">PAUSED</Badge>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <span className="size-1.5 animate-pulse rounded-full bg-[var(--color-success)]" />
                      <span className="font-mono text-[10px] uppercase text-[var(--color-success)]">
                        Active
                      </span>
                    </div>
                  )}
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-y-4 p-4">
                  <Metric label="Waiting" value={q.waiting} />
                  <Metric label="Active" value={q.active} color="text-[var(--color-info)]" />
                  <Metric label="Completed" value={q.completed} color="text-[var(--color-success)]" />
                  <Metric label="Failed" value={q.failed} color="text-[var(--color-error)]" />
                  <Metric label="Delayed" value={q.delayed} />
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function statusTone(status: string): "success" | "warning" | "error" | "info" {
  switch (status) {
    case "running":
      return "info";
    case "awaiting_approval":
    case "awaiting_input":
      return "warning";
    case "blocked":
    case "failed":
      return "error";
    case "completed":
      return "success";
    default:
      return "info";
  }
}

function Metric({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-foreground-faint)]">
        {label}
      </span>
      <span
        className={`font-mono text-[16px] font-bold ${
          color || "text-[var(--color-foreground)]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
