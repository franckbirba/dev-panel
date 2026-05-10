"use client";

import { ChevronsUpDown } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export type Project = {
  id: string;
  short: string;
  name: string;
  version?: string;
};

export function ProjectSwitcher({
  projects,
  activeId,
  onSelect,
}: {
  projects: Project[];
  activeId: string;
  onSelect?: (id: string) => void;
}) {
  const active = projects.find((p) => p.id === activeId) ?? projects[0];
  if (!active) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="lg"
          className="data-[state=open]:bg-[var(--color-sidebar-accent)]"
          onClick={() => {
            // Cycle through projects on click — proper dropdown lands in DEVPA-200
            const i = projects.findIndex((p) => p.id === active.id);
            const next = projects[(i + 1) % projects.length];
            onSelect?.(next.id);
          }}
        >
          <Avatar className="size-7">
            <AvatarFallback className="rounded-md bg-[var(--color-brand-soft)] text-[11px] font-semibold text-[var(--color-brand)]">
              {active.short}
            </AvatarFallback>
          </Avatar>
          <div className="grid flex-1 text-left text-[12.5px] leading-tight">
            <span className="truncate font-semibold">{active.name}</span>
            {active.version && (
              <span className="truncate font-mono text-[11px] text-[var(--color-foreground-faint)]">
                {active.version}
              </span>
            )}
          </div>
          <ChevronsUpDown className="ml-auto size-4 text-[var(--color-foreground-faint)]" />
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
