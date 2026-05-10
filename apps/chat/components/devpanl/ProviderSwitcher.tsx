"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ProviderOption = {
  id: string;
  label: string;
  badge?: "fast" | "cheap" | "smart" | "local";
};

export const DEFAULT_PROVIDERS: ProviderOption[] = [
  { id: "anthropic:claude-opus-4-7", label: "Claude Opus 4.7", badge: "smart" },
  { id: "anthropic:claude-sonnet-4-6", label: "Claude Sonnet 4.6", badge: "fast" },
  { id: "deepinfra:Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo", label: "Qwen3-Coder 480B", badge: "cheap" },
  { id: "openai:gpt-4o", label: "GPT-4o", badge: "fast" },
  { id: "ollama:local", label: "Local · Ollama", badge: "local" },
];

const STORAGE_KEY = "devpanl:provider";

const BADGE_COLOR: Record<NonNullable<ProviderOption["badge"]>, string> = {
  fast:  "text-[var(--color-info)]",
  cheap: "text-[var(--color-success)]",
  smart: "text-[var(--color-brand)]",
  local: "text-[var(--color-foreground-muted)]",
};

export function ProviderSwitcher({
  options = DEFAULT_PROVIDERS,
  defaultId,
  onChange,
}: {
  options?: ProviderOption[];
  defaultId?: string;
  onChange?: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string>(
    defaultId ?? options[0].id,
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && options.find((o) => o.id === stored)) {
      setSelectedId(stored);
      onChange?.(stored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pick(id: string) {
    setSelectedId(id);
    setOpen(false);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, id);
    }
    onChange?.(id);
  }

  const selected = options.find((o) => o.id === selectedId) ?? options[0];

  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 px-2 text-[12.5px]"
        onClick={() => setOpen((o) => !o)}
      >
        <span>{selected.label}</span>
        <ChevronDown className="size-3.5 text-[var(--color-foreground-faint)]" />
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] shadow-lg">
          <ul role="listbox" className="py-1">
            {options.map((opt) => (
              <li key={opt.id}>
                <button
                  type="button"
                  onClick={() => pick(opt.id)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-[var(--color-accent)]"
                >
                  <span>{opt.label}</span>
                  <div className="flex items-center gap-1.5">
                    {opt.badge && (
                      <span
                        className={`font-mono text-[10px] uppercase ${BADGE_COLOR[opt.badge]}`}
                      >
                        {opt.badge}
                      </span>
                    )}
                    {opt.id === selectedId && (
                      <Check className="size-3.5 text-[var(--color-foreground)]" />
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
