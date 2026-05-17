import { useEffect, useState } from "react";

// Agent colors based on the design specification
const AGENT_COLORS = {
  zeno: "oklch(75% 0.15 285)",   // violet
  edms: "oklch(75% 0.15 150)",   // green
  devpa: "oklch(75% 0.15 35)",   // amber
  task: "oklch(70% 0.15 215)",   // azure
};

const AGENT_COLOR_NAMES = {
  zeno: "violet",
  edms: "green",
  devpa: "amber",
  task: "azure",
};

const AGENT_SOFT_TINTS = {
  zeno: "rgba(148, 125, 255, 0.15)",
  edms: "rgba(125, 211, 165, 0.15)",
  devpa: "rgba(255, 183, 128, 0.15)",
  task: "rgba(100, 180, 255, 0.15)",
};

type FleetAgent = {
  job_id: string;
  agent: string;
  state: "running" | "awaiting_approval" | "blocked";
  work_item_short: string;
  work_item_title: string;
};

function AgentDot({ agent, isBusy }: { agent: FleetAgent; isBusy: boolean }) {
  // Determine agent type from the agent name
  let agentType = "task"; // default
  if (agent.agent.includes("zeno")) agentType = "zeno";
  else if (agent.agent.includes("edms")) agentType = "edms";
  else if (agent.agent.includes("devpa")) agentType = "devpa";
  
  const color = AGENT_COLORS[agentType as keyof typeof AGENT_COLORS];
  const softTint = AGENT_SOFT_TINTS[agentType as keyof typeof AGENT_SOFT_TINTS];
  
  return (
    <div 
      className={`relative flex size-3 items-center justify-center rounded-full ${isBusy ? "animate-pulse" : ""}`}
      style={{ backgroundColor: color }}
    >
      {isBusy && (
        <div 
          className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
          style={{ backgroundColor: softTint }}
        />
      )}
    </div>
  );
}

export function FleetStatusSidebar() {
  const [fleetAgents, setFleetAgents] = useState<FleetAgent[]>([]);
  
  useEffect(() => {
    let cancelled = false;
    
    async function fetchFleetStatus() {
      try {
        const r = await fetch("api/fleet?status=active", { credentials: "include" });
        if (!r.ok) return;
        const data = await r.json();
        
        if (cancelled) return;
        
        const fleetAgents: FleetAgent[] = (data.agents || []).map((a: any) => ({
          job_id: a.last_job_id || a.instance_id.toString(),
          agent: a.agent || a.workflow,
          state: a.status,
          work_item_short: a.identifier || "task",
          work_item_title: a.title || a.current_step || "active",
        }));
        
        setFleetAgents(fleetAgents);
      } catch (error) {
        console.error("Failed to fetch fleet status:", error);
      }
    }
    
    fetchFleetStatus();
    const timer = setInterval(fetchFleetStatus, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  
  // Group agents by project type
  const groups: Record<string, FleetAgent[]> = {
    EDMS: [],
    DEVPA: [],
    TASK: [],
  };
  
  fleetAgents.forEach(agent => {
    if (agent.agent.includes("edms")) {
      groups.EDMS.push(agent);
    } else if (agent.agent.includes("devpa")) {
      groups.DEVPA.push(agent);
    } else {
      groups.TASK.push(agent);
    }
  });
  
  // Filter out empty groups
  const projectGroups = Object.entries(groups).filter(([_, agents]) => agents.length > 0);
  
  if (projectGroups.length === 0) {
    return (
      <div className="px-3 py-2">
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-[var(--color-foreground-faint)]">
          Fleet Status
        </h3>
        <p className="mt-2 text-[11px] text-[var(--color-foreground-faint)]">
          No active agents
        </p>
      </div>
    );
  }
  
  return (
    <div className="px-3 py-2">
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-[var(--color-foreground-faint)]">
        Fleet Status
      </h3>
      
      <div className="mt-2 space-y-4">
        {projectGroups.map(([project, projectAgents]) => (
          <div key={project}>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-foreground-faint)]">
              {project}
            </div>
            
            <div className="grid grid-cols-4 gap-1">
              {projectAgents.map((agent) => {
                const isBusy = agent.state === "running";
                
                return (
                  <div 
                    key={agent.job_id}
                    className="group relative flex flex-col items-center gap-1 p-2 rounded-[4px] hover:bg-[var(--color-surface-container)] transition-colors"
                    title={`${agent.agent} - ${agent.work_item_title}`}
                  >
                    <AgentDot agent={agent} isBusy={isBusy} />
                    {isBusy && (
                      <div className="font-mono text-[9px] text-center text-[var(--color-foreground-faint)] truncate w-full">
                        {agent.work_item_short}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            
            {/* Busy task title preview */}
            {projectAgents.some(agent => agent.state === "running") && (
              <div className="mt-1 text-[11px] text-[var(--color-foreground-muted)]">
                {projectAgents
                  .filter(agent => agent.state === "running")
                  .map(agent => agent.work_item_title)
                  .join(', ')}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
