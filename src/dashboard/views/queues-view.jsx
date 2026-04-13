import { useState } from "react";
import { QueueCard } from "@/components/queue-card";
import { JobList } from "@/components/job-list";
import { JobDetail } from "@/components/job-detail";
import { ScrollArea } from "@/components/ui/scroll-area";

export function QueuesView({ apiUrl, apiKey, queueHealth, sseConnected }) {
  const [selectedQueue, setSelectedQueue] = useState(null);
  const [selectedJob, setSelectedJob] = useState(null);
  const [adminKey] = useState(() => localStorage.getItem("devpanel_admin_key") || "");

  const queues = queueHealth?.queues || [];
  const isUnreachable = !queueHealth || queueHealth.status === "unreachable";

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 p-6 max-w-[1400px] mx-auto">
        <div className="flex items-center gap-3">
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
            <div className="card-glow rounded-xl p-12">
              <div className="empty-state flex flex-col items-center justify-center gap-3 rounded-lg">
                <span className="text-error text-sm font-mono font-semibold">Redis Unreachable</span>
                <span className="text-muted-foreground/50 text-xs font-mono">Waiting for connection...</span>
              </div>
            </div>
          ) : (
            <>
              {/* Queue cards grid */}
              <div className="grid grid-cols-2 gap-4">
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

              {/* Job list for selected queue */}
              {selectedQueue && (
                <JobList
                  queueName={selectedQueue}
                  apiUrl={apiUrl}
                  apiKey={apiKey}
                  onSelectJob={(job) => setSelectedJob(job)}
                />
              )}

              {/* Job detail panel */}
              {selectedJob && selectedQueue && (
                <JobDetail
                  queueName={selectedQueue}
                  jobId={selectedJob.id}
                  apiUrl={apiUrl}
                  apiKey={apiKey}
                  adminKey={adminKey}
                  onClose={() => setSelectedJob(null)}
                />
              )}
            </>
          )}
      </div>
    </ScrollArea>
  );
}
