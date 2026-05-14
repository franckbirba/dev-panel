"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal, Loader2, Send } from "lucide-react";

type Line = {
  kind: "out" | "err" | "cmd" | "system";
  text: string;
  ts: string;
};

const WELCOME: Line[] = [
  {
    kind: "system",
    text: "DevPanel Shell — local sandbox · type `help` for hints",
    ts: new Date().toISOString(),
  },
];

const HINT = `Commands run via /api/admin/shell (sandboxed). The shell is for local
inspection only — destructive operations are blocked server-side.`;

const ALLOWED_PREFIXES = [
  "ls",
  "pwd",
  "cat",
  "echo",
  "date",
  "uname",
  "node",
  "npm",
  "git",
  "curl",
  "ps",
  "df",
  "du",
  "head",
  "tail",
  "grep",
  "find",
  "help",
  "clear",
];

export function WorkbenchShell() {
  const [lines, setLines] = useState<Line[]>(WELCOME);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function run(cmd: string) {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    const ts = new Date().toISOString();
    setLines((prev) => [...prev, { kind: "cmd", text: trimmed, ts }]);
    setHistory((h) => [...h, trimmed].slice(-50));
    setHistoryIdx(null);

    if (trimmed === "clear") {
      setLines(WELCOME);
      return;
    }
    if (trimmed === "help") {
      setLines((prev) => [
        ...prev,
        { kind: "out", text: HINT, ts: new Date().toISOString() },
        {
          kind: "out",
          text: `allowed: ${ALLOWED_PREFIXES.join(", ")}`,
          ts: new Date().toISOString(),
        },
      ]);
      return;
    }

    const head = trimmed.split(/\s+/)[0];
    if (!ALLOWED_PREFIXES.includes(head)) {
      setLines((prev) => [
        ...prev,
        {
          kind: "err",
          text: `shell: '${head}' not in allowlist. type 'help' for the list.`,
          ts: new Date().toISOString(),
        },
      ]);
      return;
    }

    setBusy(true);
    try {
      const r = await fetch("api/admin/shell", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd: trimmed }),
      });
      const ct = r.headers.get("content-type") || "";
      let body: { stdout?: string; stderr?: string; error?: string } = {};
      if (ct.includes("application/json")) {
        body = await r.json();
      } else {
        body = { stdout: await r.text() };
      }
      const now = new Date().toISOString();
      if (body.stdout) {
        setLines((prev) => [...prev, { kind: "out", text: body.stdout!, ts: now }]);
      }
      if (body.stderr) {
        setLines((prev) => [...prev, { kind: "err", text: body.stderr!, ts: now }]);
      }
      if (!r.ok) {
        setLines((prev) => [
          ...prev,
          {
            kind: "err",
            text:
              body.error ??
              `shell endpoint returned ${r.status}. backend may not expose /api/admin/shell yet.`,
            ts: now,
          },
        ]);
      }
    } catch (err) {
      setLines((prev) => [
        ...prev,
        {
          kind: "err",
          text: `shell unreachable: ${(err as Error).message}`,
          ts: new Date().toISOString(),
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const cmd = input;
      setInput("");
      run(cmd);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const next =
        historyIdx === null ? history.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(next);
      setInput(history[next]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdx === null) return;
      const next = historyIdx + 1;
      if (next >= history.length) {
        setHistoryIdx(null);
        setInput("");
      } else {
        setHistoryIdx(next);
        setInput(history[next]);
      }
    } else if (e.key === "l" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setLines(WELCOME);
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-[var(--color-background)]">
      <div className="flex items-center gap-3 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-container-lowest)] px-4 py-2">
        <Terminal className="size-4 text-[var(--color-brand)]" />
        <div className="flex flex-col">
          <span className="text-[13px] font-semibold text-[var(--color-foreground)]">
            Shell
          </span>
          <span className="font-mono text-[10px] text-[var(--color-foreground-faint)]">
            sandboxed · allowlisted commands
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-[var(--color-success)] pulse-dot glow-primary" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-foreground-muted)]">
            ready
          </span>
        </div>
      </div>

      <div
        className="custom-scrollbar flex-1 overflow-y-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed"
        onClick={() => inputRef.current?.focus()}
      >
        {lines.map((l, i) => (
          <div key={i} className="flex gap-3">
            <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-foreground-faint)] opacity-50">
              {new Date(l.ts).toLocaleTimeString([], { hour12: false })}
            </span>
            <pre
              className={[
                "whitespace-pre-wrap break-words",
                l.kind === "cmd"
                  ? "text-[var(--color-brand)]"
                  : l.kind === "err"
                    ? "text-[var(--color-error)]"
                    : l.kind === "system"
                      ? "text-[var(--color-foreground-muted)] italic"
                      : "text-[var(--color-foreground)]",
              ].join(" ")}
            >
              {l.kind === "cmd" ? `❯ ${l.text}` : l.text}
            </pre>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form
        className="flex items-center gap-2 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-container-lowest)] px-4 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          const cmd = input;
          setInput("");
          run(cmd);
        }}
      >
        <span className="font-mono text-[12px] text-[var(--color-brand)]">
          dev@local
        </span>
        <span className="font-mono text-[12px] text-[var(--color-foreground-faint)]">
          ❯
        </span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder={busy ? "running…" : "type a command (try: pwd)"}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 bg-transparent font-mono text-[12.5px] text-[var(--color-foreground)] outline-none placeholder:text-[var(--color-foreground-faint)] disabled:opacity-50"
        />
        {busy ? (
          <Loader2 className="size-4 animate-spin text-[var(--color-brand)]" />
        ) : (
          <button
            type="submit"
            aria-label="Run"
            className="rounded-md p-1.5 text-[var(--color-foreground-muted)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-brand)]"
          >
            <Send className="size-3.5" />
          </button>
        )}
      </form>
    </div>
  );
}
