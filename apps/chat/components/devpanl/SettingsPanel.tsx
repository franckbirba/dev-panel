"use client";

import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

type Tab = "members" | "dev_bots" | "project";

export type StudioMember = {
  id: string;
  name: string;
  email: string;
  initials: string;
  projects: Array<{ short: string; role: string }>;
};

export type DevBot = {
  id: string;
  label: string;
  username: string;
  status: "active" | "revoked";
  owner_name: string;
};

export type ProjectSettings = {
  short: string;
  name: string;
  github_repo?: string;
  default_branch?: string;
  env_count: number;
};

export function SettingsPanel({
  trigger,
  members = [],
  devBots = [],
  project,
  open,
  onOpenChange,
  initialTab,
}: {
  trigger?: React.ReactNode;
  members?: StudioMember[];
  devBots?: DevBot[];
  project?: ProjectSettings;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "members");

  // Sync tab when the parent re-opens the panel with a deep-link from the
  // palette (e.g. "Settings → Dev bots"). Without this, the panel keeps the
  // last-clicked tab between openings.
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {trigger ? <SheetTrigger asChild>{trigger}</SheetTrigger> : null}
      <SheetContent side="right" className="w-[480px] sm:max-w-[480px]">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>
            Studio members, dev bots, and project config.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex border-b border-[var(--color-border)]">
          {(["members", "dev_bots", "project"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-3 py-2 text-[12.5px] font-medium transition-colors ${
                tab === t
                  ? "border-[var(--color-brand)] text-[var(--color-foreground)]"
                  : "border-transparent text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)]"
              }`}
            >
              {t === "dev_bots" ? "Dev bots" : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-3 overflow-y-auto pr-1">
          {tab === "members" && <MembersTab members={members} />}
          {tab === "dev_bots" && <DevBotsTab bots={devBots} />}
          {tab === "project" &&
            (project ? (
              <ProjectTab project={project} />
            ) : (
              <p className="text-[12.5px] text-[var(--color-foreground-muted)]">
                No project selected.
              </p>
            ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function MembersTab({ members }: { members: StudioMember[] }) {
  if (members.length === 0)
    return (
      <p className="text-[12.5px] text-[var(--color-foreground-muted)]">
        No members yet.
      </p>
    );
  return (
    <ul className="space-y-2">
      {members.map((m) => (
        <li
          key={m.id}
          className="flex items-center gap-3 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-2"
        >
          <Avatar className="size-8">
            <AvatarFallback className="text-[11px]">{m.initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">{m.name}</div>
            <div className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
              {m.email}
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {m.projects.map((p) => (
                <Badge key={p.short} tone="brand">
                  {p.short} · {p.role}
                </Badge>
              ))}
            </div>
          </div>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]">
            Edit
          </Button>
        </li>
      ))}
    </ul>
  );
}

function DevBotsTab({ bots }: { bots: DevBot[] }) {
  if (bots.length === 0)
    return (
      <p className="text-[12.5px] text-[var(--color-foreground-muted)]">
        No dev bots paired.
      </p>
    );
  return (
    <ul className="space-y-2">
      {bots.map((b) => (
        <li
          key={b.id}
          className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-2"
        >
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">@{b.username}</div>
            <div className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
              {b.label} · {b.owner_name}
            </div>
          </div>
          <Badge tone={b.status === "active" ? "success" : "neutral"}>
            {b.status}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function ProjectTab({ project }: { project: ProjectSettings }) {
  return (
    <dl className="space-y-2 text-[12.5px]">
      <Field label="Short">{project.short}</Field>
      <Field label="Name">{project.name}</Field>
      <Field label="GitHub repo">{project.github_repo ?? "—"}</Field>
      <Field label="Default branch">{project.default_branch ?? "main"}</Field>
      <Field label="Env vars">{project.env_count}</Field>
    </dl>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border-subtle)] py-2 last:border-0">
      <dt className="text-[var(--color-foreground-muted)]">{label}</dt>
      <dd className="font-mono text-[11.5px]">{children}</dd>
    </div>
  );
}
