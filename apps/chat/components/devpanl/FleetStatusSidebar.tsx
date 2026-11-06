// FleetStatusSidebar.tsx - D2 fleet visualization sidebar
//
// Shows live agents grouped by project with pulsing dot indicators.
// Integrates with the existing fleet polling mechanism.

import { useState, useEffect } from "react";

interface FleetAgent {
  job_id: string;
  agent: string;
  state: "queued" | "running" | "success" | "failed" | "blocked" | "cancelled" | "awaiting_approval";
  work_item_short: string;
  work_item_title: string;
  project: "EDMS" | "task" | "DEVPA" | "ZENO";
}

const AGENT_COLOR_CLASSES: Record<string, string> = {
  EDMS: "text-[var(--color-agent-edms)]",
  task: "text-[var(--color-agent-task)]",
  DEVPA: "text-[var(--color-agent-devpa)]",
  ZENO: "text-[var(--color-agent-zeno)]",
};

const AGENT_BG_CLASSES: Record<string, string> = {
  EDMS: "bg-[var(--color-agent-edms)]",
  task: "bg-[var(--color-agent-task)]",
  DEVPA: "bg-[var(--color-agent-devpa)]",
  ZENO: "bg-[var(--color-agent-zeno)]",
};

const AGENT_LABELS: Record<string, string> = {
  EDMS: "EDMS",
  task: "Task",
  DEVPA: "DevPA",
  ZENO: "Zeno",
};

export function FleetStatusSidebar() {
  const [agents, setAgents] = useState<FleetAgent[]>([]);
  const [loading, setLoading] = useState(true);

  // Group agents by project
  const groupedAgents = agents.reduce(
    (acc, agent) => {
      if (!acc[agent.project]) {
        acc[agent.project] = [];
      }
      acc[agent.project].push(agent);
      return acc;
    },
    {} as Record<string, FleetAgent[]>
  );

  // Poll for fleet status every 10 seconds
  useEffect(() => {
    const fetchFleetStatus = async () => {
      try {
        const response = await fetch("/api/fleet?status=active");
        if (response.ok) {
          const data = await response.json();
          const fleetAgents: FleetAgent[] = (data.agents || []).map((agent: any) => ({
            job_id: agent.last_job_id || agent.instance_id.toString(),
            agent: agent.agent || agent.workflow,
            state: agent.status,
            work_item_short: agent.identifier || "task",
            work_item_title: agent.title || agent.current_step || "active",
            project: agent.project || "DEVPA", // Default to DEVPA if not specified
          }));
          setAgents(fleetAgents);
        }
      } catch (error) {
        console.error("Failed to fetch fleet status:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchFleetStatus();
    const interval = setInterval(fetchFleetStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[11px] text-[var(--color-foreground-faint)]">Loading fleet...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-container-lowest)]">
      <div className="border-b border-[var(--color-border-subtle)] px-3 py-2">
        <h2 className="text-[13px] font-semibold">Fleet Status</h2>
      </div>
      
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {Object.entries(groupedAgents).length === 0 ? (
          <div className="px-3 py-4">
            <p className="text-[11px] text-[var(--color-foreground-faint)]">
              No active agents
            </p>
          </div>
        ) : (
          Object.entries(groupedAgents).map(([project, projectAgents]) => (
            <div key={project} className="border-b border-[var(--color-border-subtle)] last:border-b-0">
              <div className="sticky top-0 bg-[var(--color-surface-container-low)] px-3 py-1.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-foreground-muted)]">
                  {AGENT_LABELS[project] || project}
                </h3>
              </div>
              
              <div className="px-2 py-1">
                {projectAgents.map((agent) => {
                  const isBusy = agent.state === "running";
                  const colorClass = AGENT_COLOR_CLASSES[agent.project] || "text-[var(--color-brand)]";
                  const bgColorClass = AGENT_BG_CLASSES[agent.project] || "bg-[var(--color-brand)]";
                  
                  return (
                    <div 
                      key={agent.job_id} 
                      className="group relative mb-1 rounded px-2 py-1.5 hover:bg-[var(--color-surface-container-low)]"
                    >
                      <div className="flex items-start">
                        <div className="relative mr-2 mt-0.5">
                          <div 
                            className={`h-2 w-2 rounded-full ${isBusy ? "pulse-dot" : ""} ${bgColorClass}`}
                          />
                          {isBusy && (
                            <div 
                              className={`absolute inset-0 rounded-full opacity-30 ${bgColorClass} pulse-dot`}
                            />
                          )}
                        </div>
                        
                        <div className="flex-1 overflow-hidden">
                          <div className="flex items-baseline justify-between">
                            <span 
                              className={`truncate text-[11px] font-medium ${colorClass}`}
                            >
                              {agent.agent}
                            </span>
                            <span className="text-[9px] text-[var(--color-foreground-faint)]">
                              {agent.work_item_short}
                            </span>
                          </div>
                          
                          <div className="mt-0.5">
                            <p className="truncate text-[10px] text-[var(--color-foreground-muted)]">
                              {agent.work_item_title}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}