"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  useChatRuntime,
  AssistantChatTransport,
} from "@assistant-ui/react-ai-sdk";
import { Thread } from "@/components/assistant-ui/thread";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  ProviderSwitcher,
  StatusBar,
  type UsageSnapshot,
  DashboardThreadList,
  type DashboardThread,
  AutoDecisionsPanel,
  type ActiveAgent,
  CommandPalette,
  SettingsPanel,
  WorkbenchEngine,
  WorkbenchLogs,
  WorkbenchShell,
  type WorkbenchView,
} from "@/components/devpanl";
import { ToolUIRegistry } from "@/lib/tool-ui-registry";
import {
  dashboardThreadListAdapter,
  loadThreadHistory,
  remoteIdFromN,
  nFromRemoteId,
  apiPathForRemoteId,
} from "@/lib/thread-list-adapter";
import {
  Sparkles,
  Cpu,
  Terminal,
  FileText,
  ChevronRight,
} from "lucide-react";

const INITIAL_USAGE: UsageSnapshot = {
  session: { tokens: 0, cost_usd: 0 },
  last24h: { tokens: 0, cost_usd: 0 },
  provider: "Qwen3-Coder · DeepInfra",
};

type HistoryMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  parts: Array<{ type: string; [key: string]: unknown }>;
};

// ─── Stitch-style top tabs (Flight Deck / Fleet / Engine / Logs) ───────
type TopTab = { id: WorkbenchView; label: string; icon: React.ComponentType<{ className?: string }> };
const TOP_TABS: TopTab[] = [
  { id: "chat", label: "Flight Deck", icon: Sparkles },
  { id: "engine", label: "Engine", icon: Cpu },
  { id: "shell", label: "Shell", icon: Terminal },
  { id: "logs", label: "Logs", icon: FileText },
];

function StitchHeader({
  activeView,
  onViewChange,
  threadN,
  providerId,
  setProviderId,
}: {
  activeView: WorkbenchView;
  onViewChange: (v: WorkbenchView) => void;
  threadN?: number;
  providerId: string;
  setProviderId: (id: string) => void;
}) {
  const tab = TOP_TABS.find((t) => t.id === activeView);
  return (
    <header className="glass-header sticky top-0 z-20 flex h-12 shrink-0 items-center gap-3 px-3">
      <SidebarTrigger className="text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)]" />

      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-[var(--color-foreground-faint)]">studio</span>
        <ChevronRight className="size-3 text-[var(--color-foreground-faint)] opacity-60" />
        <span className="text-[var(--color-foreground-muted)]">DevPanel</span>
        <ChevronRight className="size-3 text-[var(--color-foreground-faint)] opacity-60" />
        <span className="font-semibold text-[var(--color-foreground)]">
          {tab?.label ?? "Workspace"}
        </span>
        {activeView === "chat" && typeof threadN === "number" ? (
          <>
            <ChevronRight className="size-3 text-[var(--color-foreground-faint)] opacity-60" />
            <span className="text-[var(--color-brand)]">#{threadN}</span>
          </>
        ) : null}
      </div>

      {/* Top tabs */}
      <nav className="ml-4 hidden items-center gap-0.5 rounded-[8px] bg-[var(--color-surface-container-low)] p-1 md:flex">
        {TOP_TABS.map((t) => {
          const Icon = t.icon;
          const active = activeView === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onViewChange(t.id)}
              className={[
                "inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-[11.5px] font-medium transition-all",
                active
                  ? "bg-[var(--color-brand-soft)] text-[var(--color-brand)] shadow-[0_0_8px_rgba(202,190,255,0.15)]"
                  : "text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-container)] hover:text-[var(--color-foreground)]",
              ].join(" ")}
            >
              <Icon className="size-3" />
              {t.label}
            </button>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("devpanl:open-palette"));
          }}
          className="hidden items-center gap-2 rounded-[6px] border border-[var(--color-border-subtle)] bg-[var(--color-surface-container-low)] px-2.5 py-1 text-[11.5px] text-[var(--color-foreground-muted)] transition-colors hover:border-[var(--color-brand-border)] hover:text-[var(--color-foreground)] md:inline-flex"
        >
          <span>Quick actions</span>
          <kbd className="hotkey">⌘K</kbd>
        </button>
        <ProviderSwitcher defaultId={providerId} onChange={setProviderId} />
      </div>
    </header>
  );
}

function useWorkbenchMetrics() {
  const [metrics, setMetrics] = useState({
    latency: "0ms",
    throughput: "0B/s",
    status: "BOOTING",
    version: "v0.0.0",
  });

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const start = Date.now();
      try {
        const h = await fetch("api/health", { credentials: "include" });
        const latency = Date.now() - start;
        const m = await fetch("api/metrics", { credentials: "include" });
        const metricsText = await m.text();
        if (cancelled) return;

        const memMatch = metricsText.match(
          /devpanel_memory_heap_used_bytes (\d+)/,
        );
        const uptimeMatch = metricsText.match(/devpanel_uptime_seconds (\d+)/);
        const heapBytes = memMatch ? parseInt(memMatch[1], 10) : 0;
        const uptime = uptimeMatch ? parseInt(uptimeMatch[1], 10) : 0;
        const throughput =
          heapBytes > 1024 * 1024
            ? `${(heapBytes / (1024 * 1024)).toFixed(1)}MB`
            : `${(heapBytes / 1024).toFixed(1)}KB`;

        setMetrics({
          latency: `${latency}ms`,
          throughput,
          status: h.ok ? "OPTIMAL" : "DEGRADED",
          version: `UPTIME: ${Math.floor(uptime / 60)}m`,
        });
      } catch {
        if (!cancelled) setMetrics((prev) => ({ ...prev, status: "OFFLINE" }));
      }
    }
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return metrics;
}

function useThreadRuntime(remoteId: string, seedMessages: HistoryMessage[]) {
  return useChatRuntime({
    transport: new AssistantChatTransport({
      api: apiPathForRemoteId(remoteId),
      credentials: "include",
    }),
    messages: seedMessages.length > 0 ? seedMessages : undefined,
  });
}

function ThreadView({
  remoteId,
  usage,
  metrics,
}: {
  remoteId: string;
  usage: UsageSnapshot;
  metrics: ReturnType<typeof useWorkbenchMetrics>;
}) {
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [seedMessages, setSeedMessages] = useState<HistoryMessage[]>([]);

  useEffect(() => {
    let cancelled = false;
    setHistoryLoaded(false);
    setSeedMessages([]);
    loadThreadHistory(remoteId)
      .then(({ messages }) => {
        if (cancelled) return;
        setSeedMessages(messages);
        setHistoryLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setHistoryLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [remoteId]);

  const runtime = useThreadRuntime(remoteId, seedMessages);

  if (!historyLoaded) {
    return (
      <div className="flex h-dvh flex-1 items-center justify-center">
        <p className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
          loading thread #{nFromRemoteId(remoteId)}…
        </p>
      </div>
    );
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ToolUIRegistry />
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Tonal sub-header — runtime metrics */}
        <div className="flex items-center gap-4 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-container-lowest)] px-4 py-1.5">
          <div className="flex items-center gap-1.5">
            <span
              className={`size-1.5 rounded-full ${
                metrics.status === "OPTIMAL"
                  ? "bg-[var(--color-success)] glow-primary pulse-dot"
                  : "bg-[var(--color-warning)]"
              }`}
            />
            <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-foreground-muted)]">
              {metrics.version}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="flex flex-col items-end">
              <span className="font-mono text-[9px] uppercase leading-none text-[var(--color-foreground-faint)]">
                Latency
              </span>
              <span className="font-mono text-[10.5px] leading-none text-[var(--color-foreground)]">
                {metrics.latency}
              </span>
            </div>
            <div className="flex flex-col items-end border-l border-[var(--color-border-subtle)] pl-3">
              <span className="font-mono text-[9px] uppercase leading-none text-[var(--color-foreground-faint)]">
                Heap
              </span>
              <span className="font-mono text-[10.5px] leading-none text-[var(--color-foreground)]">
                {metrics.throughput}
              </span>
            </div>
            <div className="flex flex-col items-end border-l border-[var(--color-border-subtle)] pl-3">
              <span className="font-mono text-[9px] uppercase leading-none text-[var(--color-foreground-faint)]">
                Status
              </span>
              <span
                className={`font-mono text-[10.5px] font-bold leading-none ${
                  metrics.status === "OPTIMAL"
                    ? "text-[var(--color-success)]"
                    : "text-[var(--color-warning)]"
                }`}
              >
                {metrics.status}
              </span>
            </div>
          </div>
        </div>

        {/* Boss-COS auto-decisions strip */}
        <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-background)] px-3 py-2">
          <AutoDecisionsPanel />
        </div>

        <div className="flex-1 overflow-hidden bg-[var(--color-background)]">
          <Thread />
        </div>
        <StatusBar usage={usage} />
      </div>
    </AssistantRuntimeProvider>
  );
}

// ─── Outer shell — owns thread list + active thread state ──────────────────

export const Assistant = () => {
  const [providerId, setProviderId] = useState<string>(
    "deepinfra:Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo",
  );
  const [usage] = useState<UsageSnapshot>(INITIAL_USAGE);
  const [threads, setThreads] = useState<DashboardThread[]>([]);
  const [activeAgents, setActiveAgents] = useState<ActiveAgent[]>([]);
  const [activeRemoteId, setActiveRemoteId] = useState<string>(remoteIdFromN(1));
  const [threadsLoaded, setThreadsLoaded] = useState(false);
  const [activeView, setActiveView] = useState<WorkbenchView>("chat");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<
    "members" | "dev_bots" | "project"
  >("members");
  const [tailJobId, setTailJobId] = useState<string | null>(null);

  function openSettings(tab?: "members" | "dev_bots" | "project") {
    if (tab) setSettingsTab(tab);
    setSettingsOpen(true);
  }

  const metrics = useWorkbenchMetrics();

  const refreshThreads = useCallback(async () => {
    try {
      const list = await dashboardThreadListAdapter.list();
      const threadList: DashboardThread[] = list.threads.map((t) => {
        const n = nFromRemoteId(t.remoteId);
        return {
          thread_id: t.remoteId,
          subject_id: t.remoteId,
          n,
          title: t.title,
        } as DashboardThread;
      });
      setThreads(threadList);
    } catch {
      /* ignore */
    }
  }, []);

  async function refreshFleet() {
    try {
      const r = await fetch("api/fleet?status=active", {
        credentials: "include",
      });
      if (!r.ok) return;
      const data = await r.json();
      const agents: ActiveAgent[] = (data.agents || []).map((a: any) => ({
        job_id: a.last_job_id || a.instance_id.toString(),
        agent: a.agent || a.workflow,
        state: a.status,
        work_item_short: a.identifier || "task",
        work_item_title: a.title || a.current_step || "active",
      }));
      setActiveAgents(agents);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    refreshThreads().finally(() => setThreadsLoaded(true));
    refreshFleet();
    const timer = setInterval(refreshFleet, 10000);
    return () => clearInterval(timer);
  }, [refreshThreads]);

  useEffect(() => {
    function onOpenPalette() {
      setPaletteOpen(true);
    }
    window.addEventListener("devpanl:open-palette", onOpenPalette);
    return () =>
      window.removeEventListener("devpanl:open-palette", onOpenPalette);
  }, []);

  async function createThread() {
    try {
      const init = await dashboardThreadListAdapter.initialize("");
      await refreshThreads();
      setActiveRemoteId(init.remoteId);
      setActiveView("chat");
    } catch {
      /* ignore */
    }
  }

  const activeN = useMemo(() => {
    try {
      return nFromRemoteId(activeRemoteId);
    } catch {
      return 1;
    }
  }, [activeRemoteId]);

  if (!threadsLoaded) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <p className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
          loading…
        </p>
      </div>
    );
  }

  return (
    <SidebarProvider>
        <div className="flex h-dvh w-full bg-[var(--color-background)] pr-0.5">
          <DashboardThreadList
            threads={threads}
            activeN={activeN}
            onSelect={(n) => {
              setActiveRemoteId(remoteIdFromN(n));
              setActiveView("chat");
            }}
            onCreate={createThread}
            agents={activeAgents}
            activeView={activeView}
            onViewChange={setActiveView}
            onOpenSettings={() => openSettings()}
          />

          <SidebarInset className="bg-[var(--color-background)]">
            <StitchHeader
              activeView={activeView}
              onViewChange={setActiveView}
              threadN={activeView === "chat" ? activeN : undefined}
              providerId={providerId}
              setProviderId={setProviderId}
            />

            {activeView === "chat" ? (
              <ThreadView
                key={activeRemoteId}
                remoteId={activeRemoteId}
                usage={usage}
                metrics={metrics}
              />
            ) : activeView === "engine" ? (
              <WorkbenchEngine
                onTailAgent={(jobId) => {
                  setTailJobId(jobId);
                  setActiveView("logs");
                }}
              />
            ) : activeView === "shell" ? (
              <WorkbenchShell />
            ) : (
              <WorkbenchLogs initialAgentJobId={tailJobId} />
            )}
          </SidebarInset>

          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            threads={threads}
            onSelectThread={(n) => {
              setActiveRemoteId(remoteIdFromN(n));
              setActiveView("chat");
            }}
            onCreate={createThread}
            onNavigate={(v) => setActiveView(v)}
            onOpenSettings={(tab) => {
              setPaletteOpen(false);
              openSettings(tab);
            }}
          />

          <SettingsPanel
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            initialTab={settingsTab}
          />
        </div>
      </SidebarProvider>
  );
};
