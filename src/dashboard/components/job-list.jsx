import { useState, useEffect } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

const JOB_STATES = ["waiting", "active", "delayed", "failed", "completed"];

function formatJobId(id) {
  if (!id) return "—";
  const s = String(id);
  if (s.length > 20) return s.slice(0, 8) + "…";
  return s;
}

function JobRow({ job, onSelect }) {
  const time = job.timestamp ? new Date(job.timestamp).toLocaleTimeString() : "—";
  return (
    <button
      onClick={() => onSelect(job)}
      className="flex items-center gap-3 py-2.5 px-3 border-b border-border/50 last:border-0 hover:bg-secondary/30 transition-colors text-left w-full cursor-pointer"
    >
      <span className="text-muted-foreground text-[11px] font-mono w-20 shrink-0">#{formatJobId(job.id)}</span>
      <span className="flex-1 text-foreground text-[12px] font-mono font-medium truncate">{job.name}</span>
      <span className="text-muted-foreground/60 text-[10px] font-mono">{time}</span>
      {job.attempts > 0 && (
        <Badge variant="outline" className="font-mono text-[9px] px-1 py-0">
          {job.attempts}/{job.max_attempts || "∞"}
        </Badge>
      )}
      {job.failed_reason && (
        <span className="text-error text-[10px] font-mono truncate max-w-[200px]">{job.failed_reason}</span>
      )}
    </button>
  );
}

export function JobList({ queueName, apiUrl, apiKey, onSelectJob }) {
  const [activeState, setActiveState] = useState("waiting");
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!queueName) return;
    setLoading(true);
    fetch(`${apiUrl}/api/queues/${queueName}/jobs?status=${activeState}&limit=50`, {
      headers: { "X-API-Key": apiKey },
    })
      .then((r) => (r.ok ? r.json() : { jobs: [] }))
      .then((data) => setJobs(data.jobs || []))
      .catch(() => setJobs([]))
      .finally(() => setLoading(false));
  }, [queueName, activeState, apiUrl, apiKey]);

  return (
    <div className="card-glow rounded-xl p-5">
      <Tabs value={activeState} onValueChange={setActiveState}>
        <TabsList variant="line">
          {JOB_STATES.map((state) => (
            <TabsTrigger key={state} value={state} className="text-[12px] font-mono capitalize">
              {state}
            </TabsTrigger>
          ))}
        </TabsList>
        {JOB_STATES.map((state) => (
          <TabsContent key={state} value={state}>
            <ScrollArea className="max-h-[400px]">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <span className="text-muted-foreground/50 text-xs font-mono">Loading...</span>
                </div>
              ) : jobs.length === 0 ? (
                <div className="empty-state flex items-center justify-center py-8 rounded-lg">
                  <span className="text-muted-foreground/50 text-xs font-mono">No {state} jobs</span>
                </div>
              ) : (
                <div className="flex flex-col">
                  {jobs.map((job) => (
                    <JobRow key={job.id} job={job} onSelect={onSelectJob} />
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
