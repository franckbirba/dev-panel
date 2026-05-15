"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  Plus,
  Cpu,
  Terminal,
  FileText,
  MessageSquare,
  Rocket,
  Settings,
  Sparkles,
  CornerDownLeft,
  type LucideIcon,
} from "lucide-react";
import type { WorkbenchView, DashboardThread } from "./DashboardThreadList";

type CommandItem = {
  id: string;
  label: string;
  hint?: string;
  group: "Navigation" | "Threads" | "Actions" | "Agents";
  icon: LucideIcon;
  run: () => void;
};

export function CommandPalette({
  open,
  onOpenChange,
  threads,
  onSelectThread,
  onCreate,
  onNavigate,
  onOpenSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threads: DashboardThread[];
  onSelectThread: (n: number) => void;
  onCreate: () => void;
  onNavigate: (view: WorkbenchView) => void;
  onOpenSettings?: (tab?: "members" | "dev_bots" | "project") => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global cmd+K / cmd+, listeners
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        if (onOpenSettings) {
          e.preventDefault();
          onOpenSettings();
        }
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        onOpenChange(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange, onOpenSettings]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const commands: CommandItem[] = useMemo(() => {
    const base: CommandItem[] = [
      {
        id: "nav.chat",
        label: "Go to Flight Deck",
        hint: "Chat with the agent",
        group: "Navigation",
        icon: Sparkles,
        run: () => onNavigate("chat"),
      },
      {
        id: "nav.engine",
        label: "Open Engine",
        hint: "BullMQ + fleet status",
        group: "Navigation",
        icon: Cpu,
        run: () => onNavigate("engine"),
      },
      {
        id: "nav.shell",
        label: "Open Shell",
        hint: "Sandboxed terminal",
        group: "Navigation",
        icon: Terminal,
        run: () => onNavigate("shell"),
      },
      {
        id: "nav.logs",
        label: "Open Logs",
        hint: "System log stream",
        group: "Navigation",
        icon: FileText,
        run: () => onNavigate("logs"),
      },
      {
        id: "actions.new-thread",
        label: "New Session",
        hint: "Start a fresh chat thread",
        group: "Actions",
        icon: Plus,
        run: () => onCreate(),
      },
      {
        id: "actions.triage",
        label: "Triage capture inbox",
        hint: "Dispatches triage_inbox tool",
        group: "Actions",
        icon: Rocket,
        run: () => sendChatPrompt("triage the capture inbox"),
      },
      {
        id: "actions.fleet",
        label: "Show fleet status",
        hint: "Calls fleet_status",
        group: "Actions",
        icon: Cpu,
        run: () => sendChatPrompt("what's the fleet status?"),
      },
    ];
    if (onOpenSettings) {
      base.push(
        {
          id: "settings.open",
          label: "Open Settings",
          hint: "⌘,",
          group: "Navigation",
          icon: Settings,
          run: () => onOpenSettings(),
        },
        {
          id: "settings.members",
          label: "Settings → Members",
          hint: "Studio team",
          group: "Navigation",
          icon: Settings,
          run: () => onOpenSettings("members"),
        },
        {
          id: "settings.dev_bots",
          label: "Settings → Dev bots",
          hint: "Telegram pairing",
          group: "Navigation",
          icon: Settings,
          run: () => onOpenSettings("dev_bots"),
        },
        {
          id: "settings.project",
          label: "Settings → Project",
          hint: "Repo + env config",
          group: "Navigation",
          icon: Settings,
          run: () => onOpenSettings("project"),
        },
      );
    }
    for (const t of threads.slice(0, 10)) {
      base.push({
        id: `thread.${t.n}`,
        label: t.title?.replace(/^\(empty\)$/, `Thread ${t.n}`) || `Thread ${t.n}`,
        hint: `#${t.n}`,
        group: "Threads",
        icon: MessageSquare,
        run: () => onSelectThread(t.n),
      });
    }
    return base;
  }, [threads, onSelectThread, onCreate, onNavigate, onOpenSettings]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) =>
      `${c.label} ${c.hint ?? ""} ${c.group}`.toLowerCase().includes(q),
    );
  }, [commands, query]);

  const groups = useMemo(() => {
    const m = new Map<string, CommandItem[]>();
    for (const c of filtered) {
      const arr = m.get(c.group) ?? [];
      arr.push(c);
      m.set(c.group, arr);
    }
    return Array.from(m.entries());
  }, [filtered]);

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[activeIdx];
      if (cmd) {
        cmd.run();
        onOpenChange(false);
      }
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh] backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="glass w-full max-w-xl overflow-hidden rounded-[12px] shadow-2xl glow-primary"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-3">
          <Search className="size-4 text-[var(--color-foreground-muted)]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={handleKey}
            placeholder="Search commands, threads, tools…"
            className="flex-1 bg-transparent text-[14px] text-[var(--color-foreground)] outline-none placeholder:text-[var(--color-foreground-faint)]"
          />
          <kbd className="hotkey">ESC</kbd>
        </div>

        <div className="custom-scrollbar max-h-[55vh] overflow-y-auto p-1.5">
          {groups.length === 0 ? (
            <div className="px-4 py-8 text-center font-mono text-[11px] text-[var(--color-foreground-faint)]">
              No matches.
            </div>
          ) : (
            groups.map(([group, items]) => (
              <div key={group} className="mb-1">
                <div className="px-3 py-1.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-[var(--color-foreground-faint)]">
                  {group}
                </div>
                {items.map((c) => {
                  const idx = filtered.indexOf(c);
                  const active = idx === activeIdx;
                  const Icon = c.icon;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => {
                        c.run();
                        onOpenChange(false);
                      }}
                      className={[
                        "flex w-full items-center gap-3 rounded-[6px] px-3 py-2 text-left transition-colors",
                        active
                          ? "bg-[var(--color-brand-soft)] text-[var(--color-foreground)]"
                          : "text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-container)]",
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
                      <span className="flex-1 truncate text-[13px] font-medium text-[var(--color-foreground)]">
                        {c.label}
                      </span>
                      {c.hint ? (
                        <span className="font-mono text-[10px] text-[var(--color-foreground-faint)]">
                          {c.hint}
                        </span>
                      ) : null}
                      {active ? (
                        <CornerDownLeft className="size-3 text-[var(--color-brand)]" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-container-lowest)]/60 px-3 py-2 font-mono text-[10px] text-[var(--color-foreground-faint)]">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="hotkey">↑↓</kbd> navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="hotkey">↵</kbd> select
            </span>
          </div>
          <span>devpanel · cmd palette</span>
        </div>
      </div>
    </div>
  );
}

function sendChatPrompt(text: string) {
  // Fire a CustomEvent that the active ThreadView listens for. Avoids prop
  // drilling through several layers when we just want to seed a message.
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("devpanl:chat-prompt", { detail: { text } }),
    );
  }
}
