"use client";

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export type ActiveAgent = {
  job_id: string;
  agent: string;
  state: "running" | "awaiting_approval" | "blocked";
  work_item_short: string;
  work_item_title: string;
};

const STATE_DOT: Record<ActiveAgent["state"], string> = {
  running:           "bg-[var(--color-info)] animate-pulse",
  awaiting_approval: "bg-[var(--color-warning)]",
  blocked:           "bg-[var(--color-error)]",
};

export function ActiveAgentsRail({
  agents,
  onSelect,
}: {
  agents: ActiveAgent[];
  onSelect?: (jobId: string) => void;
}) {
  if (agents.length === 0) return null;

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Active agents</SidebarGroupLabel>
      <SidebarMenu>
        {agents.map((a) => (
          <SidebarMenuItem key={a.job_id}>
            <SidebarMenuButton
              onClick={() => onSelect?.(a.job_id)}
              className="h-auto items-start py-1.5"
            >
              <span className={`mt-1 size-2 shrink-0 rounded-full ${STATE_DOT[a.state]}`} />
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[12.5px] font-semibold">{a.agent}</span>
                  <span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
                    {a.work_item_short}
                  </span>
                </div>
                <span className="truncate text-[11px] text-[var(--color-foreground-muted)]">
                  {a.work_item_title}
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
