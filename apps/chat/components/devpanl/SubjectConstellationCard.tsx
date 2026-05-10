"use client";

// SubjectConstellationCard — renders the output of `subject_map`.
//
// Shape (from src/capabilities/subject-map.js):
//
//   {
//     center: { type, id, summary },
//     groups: { [type]: [{ direction, rel, type, id, summary, ... }, ...] },
//     counts: { [type]: N },
//     edge_count: N,
//     edges_error: null | string
//   }
//
// Layout: header (center summary + total edge count) + collapsible
// groups, one per subject type. Each row links to the right surface
// (Plane, GitHub, GlitchTip, AFFiNE, dashboard thread).

import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

export type ConstellationCenter = {
  type: string;
  id: string;
  summary: Record<string, unknown> | null;
};

export type ConstellationEdge = {
  direction: "in" | "out";
  rel: string;
  type: string;
  id: string;
  source?: string;
  created_at?: string;
  meta?: Record<string, unknown> | null;
  summary?: Record<string, unknown> | null;
};

export type Constellation = {
  center: ConstellationCenter;
  groups: Record<string, ConstellationEdge[]>;
  counts: Record<string, number>;
  edge_count: number;
  edges_error?: string | null;
};

const TYPE_LABEL: Record<string, string> = {
  capture: "Captures",
  work_item: "Work items",
  plane_page: "Pages Plane",
  affine_doc: "Docs AFFiNE",
  pr: "Pull requests",
  commit: "Commits",
  glitchtip_issue: "GlitchTip",
  fleet_job: "Fleet jobs",
  thread: "Threads",
  memory: "Memories",
  auto_decision: "Auto-decisions",
  deploy: "Deploys",
};

const TYPE_ICON: Record<string, string> = {
  capture: "▣",
  work_item: "◆",
  plane_page: "▤",
  affine_doc: "◳",
  pr: "⎇",
  commit: "✦",
  glitchtip_issue: "◬",
  fleet_job: "◉",
  thread: "◌",
  memory: "◇",
  auto_decision: "↺",
  deploy: "▲",
};

const REL_LABEL: Record<string, string> = {
  promoted_to: "promu en",
  reports: "remonté de",
  fixed_by: "corrigé par",
  implements: "implémente",
  ran_as: "exécuté comme",
  merged_as: "mergé en",
  documented_in: "documenté dans",
  references: "réfère à",
  blocks: "bloque",
  duplicate_of: "doublon de",
  regressed_by: "régressé par",
  retroed_in: "retro dans",
  decided_in: "décidé dans",
};

function externalUrl(
  type: string,
  id: string,
  meta?: Record<string, unknown> | null,
): string | null {
  switch (type) {
    case "pr": {
      const m = id.match(/^([^/]+)\/([^#]+)#(\d+)$/);
      if (!m) return null;
      return `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`;
    }
    case "commit": {
      const m = id.match(/^([^/]+)\/([^@]+)@([0-9a-f]+)$/i);
      if (!m) return null;
      return `https://github.com/${m[1]}/${m[2]}/commit/${m[3]}`;
    }
    case "work_item": {
      // Plane sequence id like DEVPA-217 → workspace ref.
      // The deep URL needs project_id which isn't carried in id; the
      // workspace-level identifier route works.
      if (/^[A-Z]+-\d+$/.test(id)) {
        return `https://plane.devpanl.dev/devpanl/browse/${id}/`;
      }
      return null;
    }
    case "glitchtip_issue": {
      const meta_obj = meta as { permalink?: string } | null;
      return meta_obj?.permalink ?? null;
    }
    case "affine_doc": {
      const m = id.match(/^([^/]+)\/(.+)$/);
      if (!m) return null;
      return `https://affine.devpanl.dev/workspace/${m[1]}/doc/${m[2]}`;
    }
    case "thread":
      return `/dashboard/threads/${id}`;
    case "capture":
      return `/dashboard/inbox?capture=${id}`;
    default:
      return null;
  }
}

function rowLabel(edge: ConstellationEdge): string {
  const s = edge.summary as Record<string, unknown> | null | undefined;
  if (s) {
    if (typeof s.name === "string") return s.name as string;
    if (typeof s.what === "string") return s.what as string;
    if (typeof s.content === "string") return (s.content as string).slice(0, 80);
  }
  return edge.id;
}

function GroupHeader({
  type,
  count,
  open,
  onToggle,
}: {
  type: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11.5px] hover:bg-[var(--color-muted)]"
    >
      {open ? (
        <ChevronDown className="size-3 text-[var(--color-foreground-faint)]" />
      ) : (
        <ChevronRight className="size-3 text-[var(--color-foreground-faint)]" />
      )}
      <span className="font-mono text-[var(--color-foreground-faint)]">
        {TYPE_ICON[type] ?? "·"}
      </span>
      <span className="font-medium">{TYPE_LABEL[type] ?? type}</span>
      <span className="font-mono text-[10.5px] text-[var(--color-foreground-muted)]">
        {count}
      </span>
    </button>
  );
}

function EdgeRow({ edge }: { edge: ConstellationEdge }) {
  const url = externalUrl(edge.type, edge.id, edge.meta ?? null);
  const arrow = edge.direction === "out" ? "→" : "←";
  const rel = REL_LABEL[edge.rel] ?? edge.rel;
  return (
    <li className="px-2 py-1 hover:bg-[var(--color-muted)]">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
          {arrow} {rel}
        </span>
        <div className="min-w-0 flex-1">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[12px] text-[var(--color-brand)] hover:underline"
            >
              <span className="truncate">{rowLabel(edge)}</span>
              <ExternalLink className="size-2.5" />
            </a>
          ) : (
            <span className="text-[12px]">{rowLabel(edge)}</span>
          )}
          <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-foreground-faint)]">
            {edge.id}
          </p>
        </div>
      </div>
    </li>
  );
}

export function SubjectConstellationCard({ data }: { data: Constellation }) {
  const groupTypes = Object.keys(data.groups || {}).sort();
  const [open, setOpen] = useState<Record<string, boolean>>(
    Object.fromEntries(groupTypes.map((t) => [t, true])),
  );

  const center = data.center;
  const summary = center.summary as Record<string, unknown> | null | undefined;
  const centerLabel =
    (summary?.name as string | undefined) ??
    (summary?.what as string | undefined) ??
    (summary?.content as string | undefined) ??
    center.id;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-card)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-muted)] px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12px] text-[var(--color-foreground-faint)]">
            {TYPE_ICON[center.type] ?? "·"} {TYPE_LABEL[center.type] ?? center.type}
          </span>
          <span className="font-mono text-[11px] text-[var(--color-foreground-faint)]">·</span>
          <span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
            {center.id}
          </span>
        </div>
        <p className="mt-1 truncate text-[13px]">{centerLabel}</p>
        <p className="mt-1 font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
          {data.edge_count} liens
          {data.edges_error && (
            <span className="ml-2 text-[var(--color-error)]">⚠ {data.edges_error}</span>
          )}
        </p>
      </header>
      {groupTypes.length === 0 ? (
        <p className="px-3 py-3 text-[11.5px] text-[var(--color-foreground-muted)]">
          Aucun lien — la constellation est vide pour ce sujet.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {groupTypes.map((type) => (
            <li key={type}>
              <GroupHeader
                type={type}
                count={data.counts[type] ?? data.groups[type]?.length ?? 0}
                open={!!open[type]}
                onToggle={() => setOpen((s) => ({ ...s, [type]: !s[type] }))}
              />
              {open[type] && (
                <ul className={cn("border-t border-[var(--color-border)] py-0.5")}>
                  {data.groups[type].map((edge, i) => (
                    <EdgeRow key={`${edge.id}-${edge.rel}-${i}`} edge={edge} />
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
