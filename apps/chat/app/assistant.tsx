"use client";

import { useState } from "react";
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

export const Assistant = () => {
  const [providerId, setProviderId] = useState<string>(
    "deepinfra:Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo",
  );
  const [usage] = useState<UsageSnapshot>(INITIAL_USAGE);

  const runtime = useChatRuntime({
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    transport: new AssistantChatTransport({
      api: "/api/chat",
      // The /api/chat route reads LLM_PROVIDER + LLM_MODEL server-side;
      // forwarding the user's choice as a body field is the next step
      // (DEVPA-206 backend). The dropdown ships the visible primitive now.
      headers: { "x-devpanl-provider": providerId },
    }),
  });

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
