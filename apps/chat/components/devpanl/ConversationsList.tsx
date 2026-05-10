"use client";

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export type Thread = {
  id: string;
  subject_type: "work_item" | "capture" | "ticket" | "pr" | "deploy" | "job";
  subject_short: string;
  title: string;
  last_activity: string;
  unread?: boolean;
};

const SUBJECT_LABEL: Record<Thread["subject_type"], string> = {
  work_item: "Work items",
  capture: "Captures",
  ticket: "Tickets",
  pr: "Pull requests",
  deploy: "Deploys",
  job: "Jobs",
};

export function ConversationsList({
  threads,
  activeId,
  onSelect,
}: {
  threads: Thread[];
  activeId?: string;
  onSelect?: (id: string) => void;
}) {
  // Group by subject_type
  const groups = new Map<Thread["subject_type"], Thread[]>();
  for (const t of threads) {
    if (!groups.has(t.subject_type)) groups.set(t.subject_type, []);
    groups.get(t.subject_type)!.push(t);
  }

  return (
    <>
      {Array.from(groups.entries()).map(([type, ts]) => (
        <SidebarGroup key={type}>
          <SidebarGroupLabel>{SUBJECT_LABEL[type]}</SidebarGroupLabel>
          <SidebarMenu>
            {ts.map((t) => (
              <SidebarMenuItem key={t.id}>
                <SidebarMenuButton
                  isActive={t.id === activeId}
                  onClick={() => onSelect?.(t.id)}
                  className="h-auto items-start py-2"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
                        {t.subject_short}
                      </span>
                      {t.unread && (
                        <span className="size-1.5 rounded-full bg-[var(--color-brand)]" />
                      )}
                    </div>
                    <span className="truncate text-[12.5px]">{t.title}</span>
                    <span className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
                      {t.last_activity}
                    </span>
                  </div>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </>
  );
}
