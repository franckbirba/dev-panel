"use client";

import { useEffect, useState } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  useChatRuntime,
  AssistantChatTransport,
} from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { Thread } from "@/components/assistant-ui/thread";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { Separator } from "@/components/ui/separator";
import {
  ProviderSwitcher,
  StatusBar,
  type UsageSnapshot,
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
  parts: Array<{ type: "text"; text: string }>;
};

export const Assistant = () => {
  const [providerId, setProviderId] = useState<string>(
    "deepinfra:Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo",
  );
  const [usage] = useState<UsageSnapshot>(INITIAL_USAGE);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [seedMessages, setSeedMessages] = useState<HistoryMessage[]>([]);

  // Load the persisted thread once on boot. SSO-gated; if the user is
  // signed in via Google (Traefik forwards X-Forwarded-User), the server
  // returns the freeform `dashboard/<email>` thread. On 401 (logged-out
  // / dev-localhost) we fall through to in-memory.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard/chat/history", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) return null;
        return r.json();
      })
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
  }, []);

  const runtime = useChatRuntime({
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    // Each turn POSTs the full transcript; the server persists the latest
    // user msg + the assistant reply on stream finish.
    transport: new AssistantChatTransport({
      api: "/api/dashboard/chat/turn",
      credentials: "include",
      headers: { "x-devpanl-provider": providerId },
    }),
    initialMessages: seedMessages.length > 0 ? seedMessages : undefined,
  });

  // Wait for history fetch to settle before mounting the runtime so we
  // don't show an empty thread, then have it suddenly populate. If the
  // request fails or returns nothing, mount with an empty initial state.
  if (!historyLoaded) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <p className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
          loading thread…
        </p>
      </div>
    );
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ToolUIRegistry />
      <SidebarProvider>
        <div className="flex h-dvh w-full pr-0.5">
          <ThreadListSidebar />
          <SidebarInset>
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
              <SidebarTrigger />
              <Separator orientation="vertical" className="mr-1 h-4" />
              <h1 className="text-[13px] font-semibold">DevPanel</h1>
              <span className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
                v0.42 · chat
              </span>
              <div className="ml-auto flex items-center gap-2">
                <ProviderSwitcher
                  defaultId={providerId}
                  onChange={setProviderId}
                />
              </div>
            </header>
            <div className="flex flex-1 flex-col overflow-hidden">
              <div className="flex-1 overflow-hidden">
                <Thread />
              </div>
              <StatusBar usage={usage} />
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </AssistantRuntimeProvider>
  );
};
