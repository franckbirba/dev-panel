import { useState, useEffect } from "react";
import { StatusChip } from "@/components/status-chip";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

const statusStyles = {
  waiting: "pending",
  active: "created",
  delayed: "synced",
  failed: "bug",
  completed: "published",
};

function DetailRow({ label, children }) {
  return (
    <div className="flex items-start gap-3 py-2 border-b border-border/50 last:border-0">
      <span className="text-muted-foreground text-[11px] font-mono w-24 shrink-0 pt-0.5">{label}</span>
      <div className="flex-1 text-foreground text-[12px] font-mono break-all">{children}</div>
    </div>
  );
}

export function JobDetail({ queueName, jobId, apiUrl, apiKey, adminKey, onClose }) {
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    if (!queueName || !jobId) return;
    setLoading(true);
    fetch(`${apiUrl}/api/queues/${queueName}/jobs/${jobId}`, {
      headers: { "X-API-Key": apiKey },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then(setJob)
      .catch(() => setJob(null))
      .finally(() => setLoading(false));
  }, [queueName, jobId, apiUrl, apiKey]);

  async function jobAction(action) {
    if (!adminKey) return;
    setActing(true);
    try {
      const method = action === "remove" ? "DELETE" : "POST";
      const url = action === "remove"
        ? `${apiUrl}/api/queues/${queueName}/jobs/${jobId}`
        : `${apiUrl}/api/queues/${queueName}/jobs/${jobId}/${action}`;
      await fetch(url, { method, headers: { "X-Admin-Key": adminKey } });
      onClose();
    } catch {
      // next refresh will show state
    }
    setActing(false);
  }

  if (loading) {
    return (
      <div className="card-glow rounded-xl p-5">
        <span className="text-muted-foreground/50 text-xs font-mono">Loading job...</span>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="card-glow rounded-xl p-5">
        <span className="text-muted-foreground/50 text-xs font-mono">Job not found</span>
      </div>
    );
  }

  return (
    <div className="card-glow rounded-xl p-5 h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 mb-4 min-w-0 shrink-0">
        <h3 className="text-foreground text-sm font-mono font-semibold truncate shrink-0">{job.name || `Job #${job.id}`}</h3>
        <StatusChip type={statusStyles[job.status] || "pending"} label={job.status} />
        <div className="flex-1" />
        {adminKey && (
          <div className="flex gap-2">
            {job.status === "failed" && (
              <button onClick={() => jobAction("retry")} disabled={acting} className="text-[11px] font-mono text-info hover:underline cursor-pointer disabled:opacity-50">
                Retry
              </button>
            )}
            {job.status === "delayed" && (
              <button onClick={() => jobAction("promote")} disabled={acting} className="text-[11px] font-mono text-warning hover:underline cursor-pointer disabled:opacity-50">
                Promote
              </button>
            )}
            <button onClick={() => jobAction("remove")} disabled={acting} className="text-[11px] font-mono text-error hover:underline cursor-pointer disabled:opacity-50">
              Remove
            </button>
          </div>
        )}
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm cursor-pointer">x</button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col">
          <DetailRow label="Name">{job.name}</DetailRow>
          <DetailRow label="Attempts">
            {job.attempts}/{job.max_attempts || "∞"}
          </DetailRow>
          <DetailRow label="Created">
            {job.timestamp ? new Date(job.timestamp).toLocaleString() : "—"}
          </DetailRow>
          {job.processed_on && (
            <DetailRow label="Processed">
              {new Date(job.processed_on).toLocaleString()}
            </DetailRow>
          )}
          {job.finished_on && (
            <DetailRow label="Finished">
              {new Date(job.finished_on).toLocaleString()}
            </DetailRow>
          )}
          {job.progress != null && job.progress > 0 && (
            <DetailRow label="Progress">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div className="h-full bg-info rounded-full" style={{ width: `${job.progress}%` }} />
                </div>
                <span className="text-[10px]">{job.progress}%</span>
              </div>
            </DetailRow>
          )}

          {/* Data */}
          <div className="mt-4">
            <span className="text-muted-foreground text-[11px] font-mono font-semibold uppercase tracking-wide">Data</span>
            <pre className="mt-2 p-3 bg-background rounded-lg text-[11px] font-mono text-foreground/80 whitespace-pre-wrap wrap-break-word">{JSON.stringify(job.data, null, 2)}</pre>
          </div>

          {/* Stacktrace */}
          {job.stacktrace && job.stacktrace.length > 0 && (
            <div className="mt-4">
              <span className="text-error text-[11px] font-mono font-semibold uppercase tracking-wide">Stacktrace</span>
              <pre className="mt-2 p-3 bg-error/5 border border-error/20 rounded-lg text-[11px] font-mono text-error/80 whitespace-pre-wrap wrap-break-word">{job.stacktrace.join("\n")}</pre>
            </div>
          )}

          {/* Failed reason */}
          {job.failed_reason && (
            <div className="mt-4">
              <span className="text-error text-[11px] font-mono font-semibold uppercase tracking-wide">Error</span>
              <p className="mt-1 text-error text-[12px] font-mono">{job.failed_reason}</p>
            </div>
          )}

          {/* Return value */}
          {job.return_value != null && (
            <div className="mt-4">
              <span className="text-success text-[11px] font-mono font-semibold uppercase tracking-wide">Return Value</span>
              <pre className="mt-2 p-3 bg-success/5 border border-success/20 rounded-lg text-[11px] font-mono text-success/80 whitespace-pre-wrap wrap-break-word">{JSON.stringify(job.return_value, null, 2)}</pre>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
