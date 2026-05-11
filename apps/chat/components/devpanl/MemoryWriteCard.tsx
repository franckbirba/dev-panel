"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export type MemoryWriteResult = {
	id?: number | string;
	kind?: string;
	title?: string;
	module_id?: string | null;
	work_item_id?: string | null;
	tags?: string[] | null;
};

export function MemoryWriteCard({ result }: { result: MemoryWriteResult }) {
	return (
		<Card className="w-full border-[var(--color-success)]/40">
			<CardContent className="flex items-center gap-2 py-2">
				<Badge tone="success">memory</Badge>
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						<span className="text-[12.5px] font-semibold">
							{result.title ?? "Saved"}
						</span>
						{result.kind && (
							<span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
								{result.kind}
							</span>
						)}
					</div>
					{(result.work_item_id || result.module_id) && (
						<p className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
							{result.work_item_id
								? `work_item ${result.work_item_id.slice(0, 12)}`
								: `module ${result.module_id}`}
						</p>
					)}
				</div>
				{result.id !== undefined && (
					<span className="font-mono text-[10.5px] uppercase tracking-wide text-[var(--color-foreground-faint)]">
						id {String(result.id).slice(0, 8)}
					</span>
				)}
			</CardContent>
		</Card>
	);
}
