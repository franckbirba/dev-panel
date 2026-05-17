import type {
  RemoteThreadInitializeResponse,
  RemoteThreadListAdapter,
  RemoteThreadListResponse,
  RemoteThreadMetadata,
} from "@assistant-ui/react";

type HistoryMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  parts: Array<{ type: string; [key: string]: unknown }>;
};

type ServerThread = {
  thread_id: string;
  n: number;
  title?: string;
  last_message_at?: string;
  created_at?: string;
};

const N_FROM_REMOTE_RE = /^n-(\d+)$/;

export function remoteIdFromN(n: number): string {
  return `n-${n}`;
}

export function nFromRemoteId(remoteId: string): number {
  const m = remoteId.match(N_FROM_REMOTE_RE);
  if (!m) throw new Error(`invalid remote thread id: ${remoteId}`);
  return Number(m[1]);
}

export function apiPathForRemoteId(remoteId: string): string {
  return `api/dashboard/chat/turn?n=${nFromRemoteId(remoteId)}`;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "include", ...init });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return (await r.json()) as T;
}

function metadataFromServerThread(t: ServerThread): RemoteThreadMetadata {
  return {
    status: "regular",
    remoteId: remoteIdFromN(t.n),
    title: t.title ?? `Thread #${t.n}`,
  };
}

export const dashboardThreadListAdapter: RemoteThreadListAdapter = {
  async list(): Promise<RemoteThreadListResponse> {
    const data = await fetchJson<{ threads: ServerThread[] }>(
      "api/dashboard/chat/threads",
    );
    return {
      threads: (data.threads ?? []).map(metadataFromServerThread),
    };
  },

  async initialize(): Promise<RemoteThreadInitializeResponse> {
    const data = await fetchJson<ServerThread>("api/dashboard/chat/threads", {
      method: "POST",
    });
    return {
      remoteId: remoteIdFromN(data.n),
      externalId: undefined,
    };
  },

  async fetch(remoteId: string): Promise<RemoteThreadMetadata> {
    const n = nFromRemoteId(remoteId);
    const data = await fetchJson<{ threads: ServerThread[] }>(
      "api/dashboard/chat/threads",
    );
    const found = (data.threads ?? []).find((t) => t.n === n);
    if (found) return metadataFromServerThread(found);
    return { status: "regular", remoteId, title: `Thread #${n}` };
  },

  async rename() {
    // backend has no rename endpoint yet — no-op
  },
  async archive() {
    // backend has no archive endpoint yet — no-op
  },
  async unarchive() {
    // backend has no archive endpoint yet — no-op
  },
  async delete() {
    // backend has no delete endpoint yet — no-op
  },

  generateTitle() {
    return Promise.resolve(
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }) as unknown as import("assistant-stream").AssistantStream,
    );
  },
};

export async function loadThreadHistory(remoteId: string): Promise<{
  messages: HistoryMessage[];
}> {
  const n = nFromRemoteId(remoteId);
  try {
    const data = await fetchJson<{ messages?: HistoryMessage[] }>(
      `api/dashboard/chat/history?n=${n}`,
    );
    return { messages: data.messages ?? [] };
  } catch {
    return { messages: [] };
  }
}

export type { ServerThread, HistoryMessage };
