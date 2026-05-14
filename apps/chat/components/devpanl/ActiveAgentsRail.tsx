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
      <SidebarGroupLabel className="px-2 pt-2 font-semibold text-[11px] uppercase tracking-wider text-[var(--color-foreground-faint)]">
        Fleet
      </SidebarGroupLabel>
      <SidebarMenu className="gap-0.5">
        {agents.map((a) => (
          <SidebarMenuItem key={a.job_id}>
            <SidebarMenuButton
              onClick={() => onSelect?.(a.job_id)}
              className="h-auto items-start py-2.5 transition-colors hover:bg-[var(--color-surface-1)]"
            >
              <span className={`mt-1.5 size-2 shrink-0 rounded-full shadow-[0_0_8px_rgba(0,0,0,0.5)] ${STATE_DOT[a.state] || "bg-[var(--color-foreground-faint)]"}`} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[12.5px] font-semibold tracking-tight text-[var(--color-foreground)]">
                    {a.agent}
                  </span>
                  <span className="font-mono text-[10px] text-[var(--color-foreground-muted)] opacity-70">
                    {a.work_item_short}
                  </span>
                </div>
                <span className="truncate text-[11px] leading-tight text-[var(--color-foreground-muted)]">
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
