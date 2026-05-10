"use client";

// Boss-COS one-tap response chips.
//
// Shelly emits a fenced ```chips block at the end of any turn that asks
// a yes/no/option question. This component reads the current message,
// finds that block, and renders the chips as buttons under the message.
// Click → the chip's text becomes the next user turn → Shelly continues.
//
// No new MCP tool, no new payload format, no model fine-tuning. Just a
// markdown convention Shelly follows (per SOUL.md "Suggestions inline")
// and a tiny renderer here.
//
// Why fenced markdown instead of a structured tool: the chat already
// renders the assistant message as markdown. The ```chips block stays
// readable on Telegram (where it's just a code block) AND on the dashboard
// (where we hijack the rendering). One protocol, two surfaces.

import { useMessage, useThreadRuntime } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";

type Part = { type: string; text?: string };

const CHIPS_FENCE_RE = /```chips\s*\n([\s\S]*?)```\s*$/m;

function extractChips(text: string): string[] | null {
  const m = CHIPS_FENCE_RE.exec(text);
  if (!m) return null;
  return m[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4); // hard cap per SOUL.md
}

export function MessageChips() {
  const message = useMessage();
  const runtime = useThreadRuntime();

  // Only fire on assistant messages with a final text part.
  if (!message || message.role !== "assistant") return null;
  const parts = (message.parts as Part[]) || [];
  const lastTextPart = [...parts].reverse().find((p) => p.type === "text");
  const text = lastTextPart?.text;
  if (!text) return null;

  const chips = extractChips(text);
  if (!chips || chips.length === 0) return null;

  function send(chip: string) {
    runtime.append({
      role: "user",
      content: [{ type: "text", text: chip }],
    });
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5 px-2">
      {chips.map((chip) => (
        <Button
          key={chip}
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-3 text-[12px]"
          onClick={() => send(chip)}
        >
          {chip}
        </Button>
      ))}
    </div>
  );
}
