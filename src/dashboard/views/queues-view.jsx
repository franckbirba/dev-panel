import { useState, useEffect } from "react";
import { QueueCard } from "@/components/queue-card";
import { JobList } from "@/components/job-list";
import { JobDetail } from "@/components/job-detail";
import { useAdminEvents } from "../lib/use-admin-events.js";

export function QueuesView({ apiUrl, apiKey, queueHealth, sseConnected }) {
  const [selectedQueue, setSelectedQueue] = useState(null);
  const [selectedJob, setSelectedJob] = useState(null);
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem("devpanel_admin_key") || "");
  useEffect(() => { localStorage.setItem("devpanel_admin_key", adminKey); }, [adminKey]);
  const liveEvents = useAdminEvents(adminKey);

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

      {/* Live Events pane */}
      <section style={{ marginTop: '1.5rem', padding: '0 1.5rem 1.5rem' }}>
        <header style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
          <h3 style={{ margin: 0 }}>Live events</h3>
          <input
            type="password"
            placeholder="Admin key"
            value={adminKey}
            onChange={(e) => setAdminKey(e.target.value)}
            style={{ flex: 1, padding: '0.3rem 0.5rem', fontFamily: 'inherit' }}
          />
          <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>
            {adminKey ? `${liveEvents.length} events` : 'paste key to stream'}
          </span>
        </header>
        {adminKey && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: '18rem', overflowY: 'auto', fontFamily: 'monospace', fontSize: '0.85rem' }}>
            {liveEvents.map((e, i) => (
              <li key={i} style={{ padding: '0.2rem 0', borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))' }}>
                <code>{e.type}</code>{' '}
                <span style={{ opacity: 0.85 }}>{JSON.stringify(e.data)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
