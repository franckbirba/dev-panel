"use client";

import { Plus, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export type DashboardThread = {
  thread_id: number;
  subject_id: string;
  n: number;
  title: string;
  last_message_at: string | null;
  created_at: string;
};

// DashboardThreadList — replaces the assistant-ui starter ThreadListSidebar
// (which is in-memory only). This one is wired to /api/dashboard/chat/threads:
// click a row to switch threads, click the + button to create a new one.
//
// Switching threads remounts <Assistant /> via a `key={n}` prop in page.tsx,
// because useChatRuntime doesn't easily reseed mid-session. Cheap, clean.

export function DashboardThreadList({
  threads,
  activeN,
  onSelect,
  onCreate,
  loading,
}: {
  threads: DashboardThread[];
  activeN: number;
  onSelect: (n: number) => void;
  onCreate: () => void;
  loading?: boolean;
}) {
  return (
    <Sidebar collapsible="icon" className="border-r border-[var(--color-border)]">
      <SidebarHeader>
        <Button
          type="button"
          size="sm"
          className="w-full justify-start gap-2 text-[12.5px]"
          onClick={onCreate}
          disabled={loading}
        >
          <Plus className="size-3.5" />
          <span className="group-data-[collapsible=icon]:hidden">
            New thread
          </span>
        </Button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Threads</SidebarGroupLabel>
          <SidebarMenu>
            {threads.length === 0 && !loading && (
              <p className="px-2 py-1 font-mono text-[11px] text-[var(--color-foreground-faint)]">
                no threads yet
              </p>
            )}
            {threads.map((t) => (
              <SidebarMenuItem key={t.n}>
                <SidebarMenuButton
                  isActive={t.n === activeN}
                  onClick={() => onSelect(t.n)}
                  className="h-auto items-start py-2"
                >
                  <MessageSquare className="size-3.5 shrink-0 text-[var(--color-foreground-muted)]" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[12.5px]">
                      {t.title || `Thread ${t.n}`}
                    </span>
                    <span className="font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
                      #{t.n} ·{" "}
                      {t.last_message_at
                        ? new Date(t.last_message_at).toLocaleString(undefined, {
                            dateStyle: "short",
                            timeStyle: "short",
                          })
                        : "empty"}
                    </span>
                  </div>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
