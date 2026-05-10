"use client";

import { useEffect, useState } from "react";
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
import { Separator } from "@/components/ui/separator";
import {
  ProviderSwitcher,
  StatusBar,
  type UsageSnapshot,
  DashboardThreadList,
  type DashboardThread,
  AutoDecisionsPanel,
} from "@/components/devpanl";
import { ToolUIRegistry } from "@/lib/tool-ui-registry";

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

// ─── Inner runtime — keyed on thread n so switching tears down + remounts ───
//
// useChatRuntime doesn't expose a clean "reseed messages mid-session" API,
// so the sidebar wraps this in `<Assistant key={activeN} n={activeN} />`.
// Switching threads = React unmount + remount = fresh runtime + fresh seed.

function ThreadView({
  n,
  providerId,
  setProviderId,
  usage,
}: {
  n: number;
  providerId: string;
  setProviderId: (id: string) => void;
  usage: UsageSnapshot;
}) {
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [seedMessages, setSeedMessages] = useState<HistoryMessage[]>([]);

  useEffect(() => {
    let cancelled = false;
    setHistoryLoaded(false);
    setSeedMessages([]);
    fetch(`/api/dashboard/chat/history?n=${n}`, { credentials: "include" })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.messages?.length) {
          setSeedMessages(data.messages as HistoryMessage[]);
        }
        setHistoryLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setHistoryLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [n]);

  // Server-side stopWhen: stepCountIs(8) is the single bound on the
  // tool-chain loop (see src/server/routes-dashboard-chat.js). Don't stack
  // a client-side sendAutomaticallyWhen on top — it would let one user
  // message produce two server turns of 8 steps each. (DEVPA-212)
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({
      api: `/api/dashboard/chat/turn?n=${n}`,
      credentials: "include",
      headers: { "x-devpanl-provider": providerId },
    }),
    messages: seedMessages.length > 0 ? seedMessages : undefined,
  });

  if (!historyLoaded) {
    return (
      <div className="flex h-dvh flex-1 items-center justify-center">
        <p className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
          loading thread #{n}…
        </p>
      </div>
    );
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ToolUIRegistry />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <h1 className="text-[13px] font-semibold">DevPanel</h1>
          <span className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
            v0.42 · chat · #{n}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <ProviderSwitcher
              defaultId={providerId}
              onChange={setProviderId}
            />
          </div>
        </header>
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Boss-COS panel — Shelly's auto-decisions in the last 24h.
              Collapsed by default; expand to see what she did without
              asking and roll back any of it. */}
          <div className="border-b border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2">
            <AutoDecisionsPanel />
          </div>
          <div className="flex-1 overflow-hidden">
            <Thread />
          </div>
          <StatusBar usage={usage} />
        </div>
      </SidebarInset>
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
  const [activeN, setActiveN] = useState<number>(1);
  const [threadsLoaded, setThreadsLoaded] = useState(false);

  async function refreshThreads() {
    try {
      const r = await fetch("/api/dashboard/chat/threads", {
        credentials: "include",
      });
      if (!r.ok) return;
      const data = await r.json();
      setThreads(data.threads ?? []);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    refreshThreads().finally(() => setThreadsLoaded(true));
  }, []);

  async function createThread() {
    try {
      const r = await fetch("/api/dashboard/chat/threads", {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) return;
      const data = await r.json();
      await refreshThreads();
      if (typeof data.n === "number") setActiveN(data.n);
    } catch {
      /* ignore */
    }
  }

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
      <div className="flex h-dvh w-full pr-0.5">
        <DashboardThreadList
          threads={threads}
          activeN={activeN}
          onSelect={setActiveN}
          onCreate={createThread}
        />
        {/* key forces React to tear down + remount the runtime when the
            user switches threads. The seed effect inside ThreadView
            re-runs and the chat reflects the new thread's history. */}
        <ThreadView
          key={activeN}
          n={activeN}
          providerId={providerId}
          setProviderId={setProviderId}
          usage={usage}
        />
      </div>
    </SidebarProvider>
  );
};
