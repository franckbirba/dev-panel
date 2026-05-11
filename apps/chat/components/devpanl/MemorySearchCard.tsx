"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export type MemoryRow = {
	id: number | string;
	agent?: string | null;
	kind: string;
	title: string;
	content: string;
	module_id?: string | null;
	cycle_id?: string | null;
	work_item_id?: string | null;
	tags?: string[] | null;
	created_at?: string;
	score?: number;
};

// One-line dating: ISO timestamps from Postgres can be either UTC strings
// or `Z`-suffixed; we just want a short relative label for the card.
function shortDate(iso?: string) {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const now = Date.now();
	const diffMs = now - d.getTime();
	const days = Math.floor(diffMs / 86_400_000);
	if (days === 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	return d.toISOString().slice(0, 10);
}

function MemoryRowCard({
	row,
	onOpenWorkItem,
}: {
	row: MemoryRow;
	onOpenWorkItem?: (id: string) => void;
}) {
	return (
		<Card className="w-full">
			<CardContent className="space-y-1 py-2">
				<div className="flex items-center gap-2">
					<Badge tone="brand">{row.kind}</Badge>
					{row.agent && (
						<span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
							{row.agent}
						</span>
					)}
					<span className="ml-auto font-mono text-[10.5px] uppercase tracking-wide text-[var(--color-foreground-faint)]">
						{shortDate(row.created_at)}
						{typeof row.score === "number" && ` · ${row.score.toFixed(2)}`}
					</span>
				</div>
				<div className="text-[12.5px] font-semibold">{row.title}</div>
				<p className="line-clamp-3 text-[12px] text-[var(--color-foreground-muted)]">
					{row.content}
				</p>
				<div className="flex flex-wrap items-center gap-1 pt-1">
					{(row.tags ?? []).slice(0, 4).map((t) => (
						<span
							key={t}
							className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-foreground-muted)]"
						>
							{t}
						</span>
					))}
					{row.work_item_id && (
						<Button
							size="sm"
							variant="ghost"
							className="ml-auto h-6 px-2 text-[11px]"
							onClick={() => onOpenWorkItem?.(row.work_item_id as string)}
						>
							open {row.work_item_id.slice(0, 12)}
						</Button>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

export function MemorySearchCard({
	rows,
	onOpenWorkItem,
}: {
	rows: MemoryRow[];
	onOpenWorkItem?: (id: string) => void;
}) {
	if (rows.length === 0) {
		return (
			<Card className="w-full">
				<CardContent className="py-2 text-[12px] text-[var(--color-foreground-muted)]">
					No memories matched. Try a different query or kind filter.
				</CardContent>
			</Card>
		);
	}
	return (
		<div className="my-2 flex w-full flex-col gap-2">
			{rows.map((row) => (
				<MemoryRowCard
					key={String(row.id)}
					row={row}
					onOpenWorkItem={onOpenWorkItem}
				/>
			))}
		</div>
	);
}
