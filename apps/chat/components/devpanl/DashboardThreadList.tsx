"use client";

import {
  Plus,
  MessageSquare,
  Cpu,
  Terminal,
  Rocket,
  BookOpen,
  Server,
  Network,
  FileText,
  Sparkles,
  Search,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
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

import { ActiveAgent, ActiveAgentsRail } from "./ActiveAgentsRail";
import { UserProfile } from "./UserProfile";

export type WorkbenchView = "chat" | "engine" | "logs" | "shell";

type NavItem = {
  id: WorkbenchView | "conversations" | "knowledge" | "environment" | "deploy";
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  view?: WorkbenchView;
  count?: number;
  disabled?: boolean;
};

export function DashboardThreadList({
  threads,
  activeN,
  onSelect,
  onCreate,
  loading,
  agents = [],
  activeView = "chat",
  onViewChange,
}: {
  threads: DashboardThread[];
  activeN: number;
  onSelect: (n: number) => void;
  onCreate: () => void;
  loading?: boolean;
  agents?: ActiveAgent[];
  activeView?: WorkbenchView;
  onViewChange?: (view: WorkbenchView) => void;
}) {
  const [query, setQuery] = useState("");

  const filteredThreads = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((t) =>
      (t.title || `thread ${t.n}`).toLowerCase().includes(q),
    );
  }, [threads, query]);

  const nav: NavItem[] = [
    { id: "conversations", label: "Conversations", icon: MessageSquare, view: "chat", count: threads.length },
    { id: "fleet", label: "Active Agents", icon: Rocket, view: "engine", count: agents.length } as NavItem,
    { id: "shell", label: "Shell", icon: Terminal, view: "shell" },
    { id: "deploy", label: "Deployment", icon: Server, disabled: true },
    { id: "logs", label: "Logs", icon: FileText, view: "logs" },
    { id: "knowledge", label: "Knowledge Base", icon: BookOpen, disabled: true },
    { id: "environment", label: "Environment", icon: Network, disabled: true },
  ];

  return (
    <Sidebar
      collapsible="icon"
      className="border-r-0 bg-[var(--color-sidebar)]"
    >
      {/* ── Project card ───────────────────────────────────────────────── */}
      <SidebarHeader className="px-3 pt-4 pb-2">
        <div className="flex items-center gap-3 rounded-[6px] bg-[var(--color-surface-container)] p-3 transition-colors hover:bg-[var(--color-surface-container-high)]">
          <div className="relative flex size-9 shrink-0 items-center justify-center rounded-[6px] bg-[var(--color-brand)] text-[var(--color-brand-foreground)] glow-primary">
            <Sparkles className="size-4" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
            <span className="truncate text-[13px] font-semibold leading-tight text-[var(--color-foreground)]">
              DevPanel
            </span>
            <span className="font-mono text-[10.5px] leading-tight text-[var(--color-foreground-faint)]">
              v0.42 · dev@local
            </span>
          </div>
          <div className="hidden size-1.5 shrink-0 rounded-full bg-[var(--color-success)] glow-primary group-data-[collapsible=icon]:hidden md:block pulse-dot" />
        </div>

        {/* Primary CTA — New Session */}
        <Button
          type="button"
          size="sm"
          className="mt-3 w-full gap-2 rounded-[4px] bg-[var(--color-brand-container)] py-2 font-semibold text-[12.5px] text-white shadow-[0_2px_8px_rgba(148,125,255,0.35)] transition-all hover:bg-[var(--color-brand)] hover:text-[var(--color-brand-foreground)] hover:shadow-[0_4px_16px_rgba(202,190,255,0.4)]"
          onClick={onCreate}
          disabled={loading}
        >
          <Plus className="size-3.5" />
          <span className="group-data-[collapsible=icon]:hidden">
            New Session
          </span>
        </Button>

        {/* Searchbar — opencode style */}
        <div className="relative mt-3 group-data-[collapsible=icon]:hidden">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-foreground-faint)]" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search threads, tools…"
            className="h-8 w-full rounded-[4px] border border-[var(--color-border-subtle)] bg-[var(--color-surface-container-low)] py-1 pl-8 pr-9 text-[12px] text-[var(--color-foreground)] outline-none placeholder:text-[var(--color-foreground-faint)] focus:border-[var(--color-brand-border)] focus:ring-1 focus:ring-[var(--color-brand)]/30"
          />
          <kbd className="hotkey absolute right-1.5 top-1/2 -translate-y-1/2">
            ⌘K
          </kbd>
        </div>
      </SidebarHeader>

      {/* ── Navigation ─────────────────────────────────────────────────── */}
      <SidebarContent className="custom-scrollbar gap-0 px-1.5">
        <SidebarGroup className="px-1.5">
          <SidebarGroupLabel className="pl-2 pt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-foreground-faint)]">
            Workspace
          </SidebarGroupLabel>
          <SidebarMenu>
            {nav.map((item) => {
              const Icon = item.icon;
              const active = item.view ? activeView === item.view : false;
              return (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    tooltip={item.label}
                    isActive={active}
                    disabled={item.disabled}
                    onClick={() => item.view && onViewChange?.(item.view)}
                    className={[
                      "h-8 gap-2.5 rounded-[4px] px-2.5 text-[12.5px] transition-colors",
                      "hover:bg-[var(--color-surface-container)]",
                      "data-[active=true]:bg-[var(--color-brand-soft)]",
                      "data-[active=true]:text-[var(--color-brand)]",
                      "data-[active=true]:font-semibold",
                      item.disabled
                        ? "cursor-not-allowed opacity-40 hover:bg-transparent"
                        : "",
                    ].join(" ")}
                  >
                    <Icon
                      className={[
                        "size-3.5 shrink-0",
                        active
                          ? "text-[var(--color-brand)]"
                          : "text-[var(--color-foreground-muted)]",
                      ].join(" ")}
                    />
                    <span className="flex-1 truncate">{item.label}</span>
                    {typeof item.count === "number" && item.count > 0 ? (
                      <span className="font-mono text-[10px] text-[var(--color-foreground-faint)] group-data-[collapsible=icon]:hidden">
                        {item.count}
                      </span>
                    ) : null}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>

        {/* Active agents rail — live fleet */}
        {agents.length > 0 ? (
          <SidebarGroup className="px-1.5 pt-1">
            <SidebarGroupLabel className="pl-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-foreground-faint)]">
              Active Agents
            </SidebarGroupLabel>
            <ActiveAgentsRail agents={agents} />
          </SidebarGroup>
        ) : null}

        {/* Thread history list */}
        <SidebarGroup className="px-1.5 pt-1">
          <SidebarGroupLabel className="pl-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-foreground-faint)]">
            Recent
          </SidebarGroupLabel>
          <SidebarMenu>
            {filteredThreads.length === 0 && !loading && (
              <p className="px-2.5 py-1 font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
                {query ? "no matches" : "no threads yet"}
              </p>
            )}
            {filteredThreads.slice(0, 12).map((t) => {
              const isActive = t.n === activeN && activeView === "chat";
              return (
                <SidebarMenuItem key={t.n}>
                  <SidebarMenuButton
                    isActive={isActive}
                    onClick={() => onSelect(t.n)}
                    className={[
                      "h-auto items-start gap-2.5 rounded-[4px] px-2.5 py-2 transition-colors",
                      "hover:bg-[var(--color-surface-container)]",
                      "data-[active=true]:bg-[var(--color-brand-soft)]",
                      "data-[active=true]:text-[var(--color-foreground)]",
                    ].join(" ")}
                  >
                    <MessageSquare
                      className={[
                        "mt-0.5 size-3 shrink-0",
                        isActive
                          ? "text-[var(--color-brand)]"
                          : "text-[var(--color-foreground-faint)]",
                      ].join(" ")}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5 group-data-[collapsible=icon]:hidden">
                      <span className="truncate text-[12px] font-medium">
                        {t.title?.replace(/^\(empty\)$/, `Thread ${t.n}`) ||
                          `Thread ${t.n}`}
                      </span>
                      <span className="font-mono text-[10px] text-[var(--color-foreground-faint)]">
                        #{t.n} ·{" "}
                        {t.last_message_at
                          ? new Date(t.last_message_at).toLocaleString(
                              undefined,
                              { dateStyle: "short", timeStyle: "short" },
                            )
                          : "empty"}
                      </span>
                    </div>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      {/* ── Footer — Profile + Documentation + System Status ────────────── */}
      <SidebarFooter className="px-3 pb-3 pt-2 group-data-[collapsible=icon]:hidden">
        <UserProfile />
        <a
          href="https://github.com/franckbirba/dev-panel"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-[11.5px] text-[var(--color-foreground-muted)] transition-colors hover:bg-[var(--color-surface-container)] hover:text-[var(--color-foreground)]"
        >
          <BookOpen className="size-3.5" />
          Documentation
        </a>
        <div className="flex items-center gap-2 rounded-[4px] bg-[var(--color-surface-container-low)] px-2 py-1.5">
          <div className="size-1.5 rounded-full bg-[var(--color-success)] pulse-dot glow-primary" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-foreground-muted)]">
            System Online
          </span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
