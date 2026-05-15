"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "lucide-react";

type Source = "backend" | "next" | "worker" | "agent";

type AgentEntry = {
  id: string;
  ts: string;
  seq: string;
  type: string;
  subtype: string;
  body: string;
  isError: boolean;
};

const SOURCES: { id: Source; label: string }[] = [
  { id: "backend", label: "API" },
  { id: "next", label: "Next" },
  { id: "worker", label: "Worker" },
  { id: "agent", label: "Agent" },
];

const TYPE_STYLES: Record<string, { badge: string; body: string }> = {
  user: {
    badge: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    body: "text-sky-100/90",
  },
  assistant: {
    badge: "bg-violet-500/15 text-violet-300 border-violet-500/30",
    body: "text-violet-100/90",
  },
  system: {
    badge: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
    body: "text-cyan-100/80",
  },
  tool_use: {
    badge: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    body: "text-amber-100/90",
  },
  tool_result: {
    badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    body: "text-emerald-100/90",
  },
  result: {
    badge: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30",
    body: "text-fuchsia-100/90",
  },
  error: {
    badge: "bg-red-500/15 text-red-300 border-red-500/40",
    body: "text-red-200",
  },
  warn: {
    badge: "bg-amber-500/15 text-amber-300 border-amber-500/40",
    body: "text-amber-100/90",
  },
  info: {
    badge: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    body: "text-sky-100/80",
  },
  debug: {
    badge: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
    body: "text-zinc-400/80",
  },
  log: {
    badge: "bg-emerald-500/10 text-emerald-300 border-emerald-500/25",
    body: "text-emerald-100/80",
  },
};

const TS_PREFIX_RE = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+/;
const BRACKET_TS_RE = /^\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\s+/;
const LEVEL_RE = /\b(ERROR|WARN(?:ING)?|INFO|DEBUG|FATAL|TRACE)\b/i;
// Heuristic anchors for log lines without a timestamp prefix. We look for
// well-known event starts so multi-line stack traces / JSON dumps coalesce
// instead of fragmenting into one row per line.
const ANCHOR_RE =
  /^(Error|TypeError|RangeError|ReferenceError|SyntaxError|UnhandledPromiseRejection|Warning|FATAL|PANIC|✗|✓|✅|❌|⚠|>>|<<|\[\w+\]|\w+Error:|GET\s|POST\s|PUT\s|PATCH\s|DELETE\s|info\b|warn\b|error\b|debug\b)/i;

function classifyLine(text: string): { type: string; isError: boolean } {
  const lower = text.toLowerCase();
  if (/error\b|exception\b|econnrefused|enotfound|fatal\b|panic\b|❌|✗/i.test(text)) {
    return { type: "error", isError: true };
  }
  if (/\bwarn(ing)?\b|⚠/i.test(text)) return { type: "warn", isError: false };
  if (/\binfo\b|✓|✅|listening on|ready in|started/i.test(lower)) {
    return { type: "info", isError: false };
  }
  if (/\bdebug\b/i.test(lower)) return { type: "debug", isError: false };
  const m = text.match(LEVEL_RE);
  if (m) {
    const lvl = m[1].toLowerCase();
    if (lvl === "warning" || lvl === "warn") return { type: "warn", isError: false };
    if (lvl === "fatal") return { type: "error", isError: true };
    return { type: lvl, isError: lvl === "error" };
  }
  return { type: "log", isError: false };
}

function parseLocalLog(text: string): AgentEntry[] {
  if (!text) return [];
  const lines = text.split("\n");
  const out: AgentEntry[] = [];
  let buf: string[] = [];
  let ts = "";
  let counter = 0;

  function flush() {
    if (!buf.length) return;
    const body = buf.join("\n").replace(/\s+$/, "");
    if (!body) {
      buf = [];
      return;
    }
    const { type, isError } = classifyLine(body);
    counter += 1;
    out.push({
      id: `loc-${counter}`,
      ts,
      seq: "",
      type,
      subtype: "",
      body,
      isError,
    });
    buf = [];
    ts = "";
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    const m1 = line.match(TS_PREFIX_RE);
    const m2 = !m1 ? line.match(BRACKET_TS_RE) : null;
    // A non-timestamp anchor: flush only if the previous group has content
    // AND the new line starts at column 0 with a recognised event start.
    const isAnchored =
      !m1 && !m2 && buf.length > 0 && /^\S/.test(line) && ANCHOR_RE.test(line);

    if (m1 || m2) {
      flush();
      ts = m1 ? m1[1] : new Date().toISOString().slice(0, 11) + (m2 ? m2[1] : "");
      const rest = line.slice(m1 ? m1[0].length : m2![0].length);
      buf.push(rest);
    } else if (isAnchored) {
      flush();
      buf.push(line);
    } else if (line.length === 0) {
      if (buf.length) buf.push("");
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

const DEFAULT_STYLE = {
  badge: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  body: "text-zinc-200/85",
};

function styleFor(type: string, isError: boolean) {
  if (isError) return TYPE_STYLES.error;
  return TYPE_STYLES[type] ?? DEFAULT_STYLE;
}

function shortStamp(stamp: string): string {
  if (!stamp) return "";
  const d = new Date(stamp);
  if (Number.isNaN(d.getTime())) return stamp.slice(11, 23);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function extractBody(data: Record<string, unknown>, raw: string): { body: string; isError: boolean } {
  let body = "";
  let isError = false;

  const payloadJson = (data.payload_json as string | undefined) ?? null;
  const payload = data.payload;

  if (payloadJson) {
    try {
      const p = JSON.parse(payloadJson) as Record<string, unknown>;
      isError = Boolean(p.is_error);
      const msg = p.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      if (Array.isArray(content) && content[0]) {
        const first = content[0] as Record<string, unknown>;
        body =
          (first.text as string) ||
          (first.content as string) ||
          (first.input ? JSON.stringify(first.input, null, 2) : "") ||
          JSON.stringify(first, null, 2);
      } else {
        body =
          (p.text as string) ||
          (p.content as string) ||
          (p.result as string) ||
          JSON.stringify(p, null, 2);
      }
    } catch {
      body = payloadJson;
    }
  } else if (payload != null) {
    body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  } else {
    body = raw;
  }
  if (body.length > 8000) body = body.slice(0, 8000) + "\n…(truncated)";

  return { body, isError };
}

export function WorkbenchLogs({
  initialAgentJobId,
}: {
  initialAgentJobId?: string | null;
}) {
  const [logs, setLogs] = useState<string>("");
  const [entries, setEntries] = useState<AgentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<Source>(
    initialAgentJobId ? "agent" : "backend",
  );
  const [jobId, setJobId] = useState<string>(initialAgentJobId ?? "");
  const [jobInput, setJobInput] = useState<string>(initialAgentJobId ?? "");
  const [streamDone, setStreamDone] = useState<{
    reason: "job_done" | "idle";
    lastSeq: string;
    count: number;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const entryCounter = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeqRef = useRef<string>("");
  const countRef = useRef<number>(0);

  useEffect(() => {
    if (initialAgentJobId) {
      setSource("agent");
      setJobId(initialAgentJobId);
      setJobInput(initialAgentJobId);
    }
  }, [initialAgentJobId]);

  useEffect(() => {
    if (source !== "agent") return;
    if (!jobId) {
      setEntries([]);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setEntries([]);
    setStreamDone(null);
    entryCounter.current = 0;
    countRef.current = 0;
    lastSeqRef.current = "";

    const url = `api/admin/jobs/${encodeURIComponent(jobId)}/events?stream=1`;
    const es = new EventSource(url, { withCredentials: true });

    function armIdleTimer() {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      // 3s after the last event with no new arrivals = stream is settled.
      // Past completed jobs never receive job_done (worker already exited
      // before we subscribed), so this is the only way to signal "this is
      // the whole log".
      idleTimer.current = setTimeout(() => {
        if (cancelled) return;
        if (countRef.current === 0) return;
        setStreamDone((prev) =>
          prev ?? {
            reason: "idle",
            lastSeq: lastSeqRef.current,
            count: countRef.current,
          },
        );
      }, 3000);
    }

    es.onopen = () => {
      if (cancelled) return;
      setLoading(false);
    };

    function handleEvent(ev: MessageEvent) {
      if (cancelled) return;
      try {
        const data = JSON.parse(ev.data) as Record<string, unknown>;
        const ts = (data.created_at as string) || (data.ts as string) || "";
        const seq = data.seq != null ? String(data.seq) : "";
        const type = (data.event_type as string) || (data.type as string) || "";
        const subtype = (data.event_subtype as string) || "";
        const { body, isError } = extractBody(data, ev.data);
        entryCounter.current += 1;
        countRef.current += 1;
        if (seq) lastSeqRef.current = seq;
        const entry: AgentEntry = {
          id: `${entryCounter.current}-${seq || ts}`,
          ts,
          seq,
          type,
          subtype,
          body,
          isError,
        };
        setEntries((prev) => [...prev, entry]);
        setStreamDone(null);
        armIdleTimer();
      } catch {
        entryCounter.current += 1;
        countRef.current += 1;
        setEntries((prev) => [
          ...prev,
          {
            id: `${entryCounter.current}-raw`,
            ts: "",
            seq: "",
            type: "raw",
            subtype: "",
            body: ev.data.slice(0, 600),
            isError: false,
          },
        ]);
        setStreamDone(null);
        armIdleTimer();
      }
    }

    function handleDone() {
      if (cancelled) return;
      if (idleTimer.current) clearTimeout(idleTimer.current);
      setStreamDone({
        reason: "job_done",
        lastSeq: lastSeqRef.current,
        count: countRef.current,
      });
    }

    es.onmessage = handleEvent;
    es.addEventListener("job_event", handleEvent as EventListener);
    es.addEventListener("job_done", handleDone as EventListener);

    es.onerror = () => {
      if (cancelled) return;
      // EventSource fires onerror on normal close too. If we already have
      // events and an idle marker, treat that as "stream complete", not a
      // failure. Otherwise surface the disconnect.
      if (countRef.current > 0) {
        setLoading(false);
        if (!streamDone) {
          setStreamDone({
            reason: "idle",
            lastSeq: lastSeqRef.current,
            count: countRef.current,
          });
        }
        return;
      }
      setError("stream disconnected");
      setLoading(false);
    };

    return () => {
      cancelled = true;
      if (idleTimer.current) clearTimeout(idleTimer.current);
      es.removeEventListener("job_event", handleEvent as EventListener);
      es.removeEventListener("job_done", handleDone as EventListener);
      es.close();
    };
    // streamDone is intentionally excluded — re-running the effect on every
    // event would tear the EventSource down mid-stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, jobId]);

  useEffect(() => {
    if (source === "agent") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLogs("");

    async function fetchLogs() {
      try {
        const r = await fetch(
          `api/admin/local-log?source=${source}&lines=500`,
          { credentials: "include" },
        );
        const text = await r.text();
        if (cancelled) return;
        if (!r.ok) {
          setError(`${r.status} ${r.statusText} — ${text.slice(0, 240)}`);
          setLoading(false);
          return;
        }
        setLogs(text);
        setError(null);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(`fetch failed: ${(err as Error).message}`);
        setLoading(false);
      }
    }

    fetchLogs();
    const timer = setInterval(fetchLogs, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [source]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, entries]);

  const headerLabel =
    source === "agent"
      ? `agent ${jobId || "(no job)"}`
      : `${source} (tail 500)`;

  const isNotFoundSentinel =
    source !== "agent" &&
    /(log not found yet|process may not have logged|no log file|^# log not|has no fallback file path|has no recent output)/i.test(
      logs.slice(0, 240),
    );

  const sourceHint =
    source === "worker"
      ? "Worker runs as systemd on the agents host. Use the Agent tab with a job ID to see per-job stderr — the worker doesn't expose a global tail through this endpoint."
      : source === "next"
        ? "Next.js dev output is only available locally (npm run dev tees to /tmp/next-chat-dev.log). In prod the chat is statically exported and served by the API container."
        : null;

  const localEntries =
    source !== "agent" && logs && !isNotFoundSentinel ? parseLocalLog(logs) : [];

  const hasContent =
    source === "agent" ? entries.length > 0 : Boolean(logs);

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-[#050506]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] px-4 py-2">
        <Terminal className="size-3.5 text-[var(--color-foreground-muted)]" />
        <span className="font-mono text-[11px] uppercase tracking-wider text-[var(--color-foreground-muted)]">
          Logs · {headerLabel}
        </span>
        {source === "agent" && entries.length > 0 && (
          <span className="font-mono text-[10px] text-[var(--color-foreground-faint)]">
            · {entries.length} events
          </span>
        )}
        {source === "agent" && streamDone && (
          <span
            className="font-mono text-[10px] uppercase tracking-wider text-emerald-300"
            title={
              streamDone.reason === "job_done"
                ? "Worker emitted job_done"
                : "No new events for 3s — replay complete"
            }
          >
            · stream complete
            {streamDone.lastSeq ? ` · seq ${streamDone.lastSeq}` : ""}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSource(s.id)}
              className={[
                "rounded-md px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors cursor-pointer",
                source === s.id
                  ? "bg-[var(--color-brand-soft)] text-[var(--color-brand)]"
                  : "text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-container)]",
              ].join(" ")}
            >
              {s.label}
            </button>
          ))}
          {loading && !error && (
            <span className="ml-2 animate-pulse font-mono text-[10px] text-[var(--color-brand)]">
              {source === "agent" ? "STREAMING..." : "POLLING..."}
            </span>
          )}
        </div>
      </div>
      {source === "agent" && (
        <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] px-4 py-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-foreground-faint)]">
            Job ID
          </span>
          <input
            value={jobInput}
            onChange={(e) => setJobInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setJobId(jobInput.trim());
            }}
            placeholder="paste BullMQ job id (e.g. 4110)"
            className="flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-background)] px-2 py-1 font-mono text-[11px] text-[var(--color-foreground)] focus:border-[var(--color-brand)] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setJobId(jobInput.trim())}
            className="rounded-md bg-[var(--color-brand-soft)] px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-[var(--color-brand)] hover:opacity-80 cursor-pointer"
          >
            Tail
          </button>
        </div>
      )}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto bg-[#050506] font-mono text-[12px] leading-relaxed"
      >
        {error ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[var(--color-error)]">
            <div>
              <div className="font-semibold">
                {source === "agent"
                  ? "stream unavailable"
                  : "log endpoint unreachable"}
              </div>
              <div className="mt-1 text-[11px] opacity-80">{error}</div>
            </div>
          </div>
        ) : hasContent ? (
          source === "agent" ? (
            <div className="flex flex-col">
              {entries.map((e) => (
                <EventRow key={e.id} entry={e} />
              ))}
            </div>
          ) : isNotFoundSentinel ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-[var(--color-foreground-faint)]">
              <div className="max-w-xl space-y-3">
                <pre className="whitespace-pre-wrap font-mono text-[11px]">{logs}</pre>
                {sourceHint && (
                  <p className="font-mono text-[11px] leading-relaxed text-[var(--color-foreground-muted)]">
                    {sourceHint}
                  </p>
                )}
              </div>
            </div>
          ) : localEntries.length > 0 ? (
            <div className="flex flex-col">
              {localEntries.map((e) => (
                <EventRow key={e.id} entry={e} />
              ))}
            </div>
          ) : (
            <pre className="whitespace-pre-wrap p-4 text-[#d1d1d1]">{logs}</pre>
          )
        ) : (
          <div className="flex h-full items-center justify-center text-[var(--color-foreground-faint)]">
            {loading
              ? source === "agent"
                ? "Connecting to event stream..."
                : "Initializing log stream..."
              : source === "agent" && !jobId
                ? "Paste a job ID above or click Tail on an agent card."
                : `No logs yet for "${source}".`}
          </div>
        )}
      </div>
    </div>
  );
}

function EventRow({ entry }: { entry: AgentEntry }) {
  const style = styleFor(entry.type, entry.isError);
  const [expanded, setExpanded] = useState(false);
  const lines = entry.body.split("\n");
  const truncated = !expanded && (lines.length > 6 || entry.body.length > 400);
  const displayed = truncated
    ? lines.slice(0, 6).join("\n").slice(0, 400)
    : entry.body;
  return (
    <div className="group flex items-start gap-3 border-b border-white/[0.03] px-4 py-1.5 hover:bg-white/[0.02]">
      <span className="shrink-0 select-none pt-[1px] font-mono text-[10px] text-[var(--color-foreground-faint)]/60 tabular-nums">
        {shortStamp(entry.ts)}
      </span>
      {entry.seq && (
        <span className="shrink-0 select-none pt-[1px] font-mono text-[10px] text-[var(--color-foreground-faint)]/40 tabular-nums">
          #{entry.seq}
        </span>
      )}
      <span
        className={[
          "shrink-0 rounded border px-1.5 py-[1px] font-mono text-[9px] uppercase tracking-wider",
          style.badge,
        ].join(" ")}
      >
        {entry.type || "evt"}
        {entry.subtype ? `:${entry.subtype}` : ""}
        {entry.isError ? " ⚠" : ""}
      </span>
      <div className="min-w-0 flex-1">
        <pre
          className={[
            "whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed",
            style.body,
          ].join(" ")}
        >
          {displayed}
        </pre>
        {(truncated || expanded) && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-0.5 cursor-pointer font-mono text-[10px] uppercase tracking-wider text-[var(--color-foreground-faint)]/70 hover:text-[var(--color-brand)]"
          >
            {expanded ? "← collapse" : `… expand (${lines.length} lines, ${entry.body.length}b)`}
          </button>
        )}
      </div>
    </div>
  );
}
