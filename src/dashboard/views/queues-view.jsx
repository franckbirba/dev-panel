import { useState } from "react";
import { QueueCard } from "@/components/queue-card";
import { JobList } from "@/components/job-list";
import { JobDetail } from "@/components/job-detail";

export function QueuesView({ apiUrl, apiKey, queueHealth, sseConnected }) {
  const [selectedQueue, setSelectedQueue] = useState(null);
  const [selectedJob, setSelectedJob] = useState(null);
  const [adminKey] = useState(() => localStorage.getItem("devpanel_admin_key") || "");

  const queues = queueHealth?.queues || [];
  const isUnreachable = !queueHealth || queueHealth.status === "unreachable";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 pt-4 pb-2 shrink-0">
        <h2 className="text-foreground text-[13px] font-semibold tracking-wide uppercase">Queue Monitor</h2>
        <div className="flex-1 h-px bg-border/50" />
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${sseConnected ? "bg-success animate-pulse" : "bg-error"}`} />
          <span className="text-muted-foreground/40 text-[10px] font-mono">
            {sseConnected ? "live" : "disconnected"}
          </span>
        </div>
      </div>

      {isUnreachable ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="card-glow rounded-xl p-12">
            <div className="flex flex-col items-center gap-3">
              <span className="text-error text-sm font-mono font-semibold">Redis Unreachable</span>
              <span className="text-muted-foreground/50 text-xs font-mono">Waiting for connection...</span>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Queue cards — compact horizontal strip */}
          <div className="flex gap-3 px-6 py-3 overflow-x-auto shrink-0">
            {queues.map((q) => (
              <QueueCard
                key={q.queue}
                queue={q}
                selected={selectedQueue === q.queue.replace("devpanel:", "")}
                onSelect={setSelectedQueue}
                apiUrl={apiUrl}
                adminKey={adminKey}
              />
            ))}
          </div>

          {/* Bottom area: job list + job detail side by side */}
          {selectedQueue && (
            <div className="flex-1 min-h-0 flex gap-4 px-6 pb-4">
              {/* Job list — left panel */}
              <div className="w-[400px] shrink-0 overflow-hidden">
                <JobList
                  queueName={selectedQueue}
                  apiUrl={apiUrl}
                  apiKey={apiKey}
                  onSelectJob={(job) => setSelectedJob(job)}
                />
              </div>

              {/* Job detail — right panel, fills remaining space */}
              {selectedJob && (
                <div className="flex-1 min-w-0 overflow-hidden">
                  <JobDetail
                    queueName={selectedQueue}
                    jobId={selectedJob.id}
                    apiUrl={apiUrl}
                    apiKey={apiKey}
                    adminKey={adminKey}
                    onClose={() => setSelectedJob(null)}
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
