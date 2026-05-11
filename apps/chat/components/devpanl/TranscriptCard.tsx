"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export type TranscriptRow = {
	id: number | string;
	ts: string;
	bot_label?: string | null;
	direction?: "in" | "out";
	role?: string | null;
	source?: string | null;
	thread_subject?: string | null;
	content: string;
};

function fmtTime(ts?: string) {
	if (!ts) return "";
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return ts;
	return d.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function TranscriptCard({ rows }: { rows: TranscriptRow[] }) {
	if (rows.length === 0) {
		return (
			<Card className="w-full">
				<CardContent className="py-2 text-[12px] text-[var(--color-foreground-muted)]">
					No transcript rows in that window.
				</CardContent>
			</Card>
		);
	}
	return (
		<Card className="w-full">
			<CardContent className="max-h-96 space-y-1 overflow-y-auto py-2">
				{rows.map((row) => {
					const isOut = row.direction === "out";
					const align = isOut ? "items-end" : "items-start";
					const bubble = isOut
						? "bg-[var(--color-brand-soft)] text-[var(--color-foreground)] border-[var(--color-brand-border)]"
						: "bg-[var(--color-surface-2)] text-[var(--color-foreground)] border-[var(--color-border)]";
					return (
						<div key={String(row.id)} className={`flex flex-col ${align}`}>
							<div className="flex items-center gap-1 text-[10px] text-[var(--color-foreground-faint)]">
								<span className="font-mono">{fmtTime(row.ts)}</span>
								{row.bot_label && (
									<span className="font-mono">· {row.bot_label}</span>
								)}
								{row.role && <span className="font-mono">· {row.role}</span>}
								{row.thread_subject && (
									<Badge tone="neutral">{row.thread_subject}</Badge>
								)}
							</div>
							<div
								className={`mt-0.5 max-w-[90%] whitespace-pre-wrap break-words rounded-md border px-2 py-1 text-[12px] ${bubble}`}
							>
								{row.content}
							</div>
						</div>
					);
				})}
			</CardContent>
		</Card>
	);
}
