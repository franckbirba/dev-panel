"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export type WorkflowInstance = {
	instance_id: string;
	workflow: string;
	state?: string;
	current_step?: string;
	repo?: string;
	pr_number?: number;
	work_item_id?: string;
	last_event_at?: string;
	created_at?: string;
};

function toneForState(state?: string) {
	if (state === "completed" || state === "success") return "success" as const;
	if (state === "failed" || state === "blocked") return "error" as const;
	if (state === "running") return "info" as const;
	return "neutral" as const;
}

export function WorkflowInstancesCard({
	instances,
	onTail,
}: {
	instances: WorkflowInstance[];
	onTail?: (instanceId: string) => void;
}) {
	if (instances.length === 0) {
		return (
			<Card className="w-full">
				<CardContent className="py-3 text-[12px] font-mono uppercase tracking-wider text-[var(--color-foreground-faint)]">
					No active workflow instances.
				</CardContent>
			</Card>
		);
	}
	return (
		<div className="my-3 flex w-full flex-col gap-2">
			{instances.map((inst) => (
				<Card key={inst.instance_id} className="group w-full border-l-2" style={{ borderLeftColor: `var(--color-${toneForState(inst.state)})` }}>
					<CardContent className="flex items-center gap-3 py-3">
						<Badge tone={toneForState(inst.state)} className="px-2 py-0">
							{inst.state ?? "pending"}
						</Badge>
						<div className="min-w-0 flex-1">
							<div className="flex items-baseline gap-2">
								<span className="text-[13px] font-bold tracking-tight">
									{inst.workflow}
								</span>
								{inst.current_step && (
									<span className="font-mono text-[11px] font-medium text-[var(--color-foreground-muted)] opacity-80">
										{inst.current_step}
									</span>
								)}
							</div>
							<div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-tighter text-[var(--color-foreground-faint)]">
								{inst.repo && (
									<span className="flex items-center gap-1">
										{inst.repo}
										{inst.pr_number ? `#${inst.pr_number}` : ""}
									</span>
								)}
								{(inst.repo || inst.work_item_id) && <span>·</span>}
								{inst.work_item_id && <span>{inst.work_item_id} ·</span>}
								<span className="opacity-60">{inst.instance_id.slice(0, 12)}</span>
							</div>
						</div>
						<Button
							size="sm"
							variant="ghost"
							className="h-7 rounded-lg px-3 font-mono text-[10px] uppercase tracking-widest transition-all hover:bg-[var(--color-surface-3)] opacity-0 group-hover:opacity-100"
							onClick={() => onTail?.(inst.instance_id)}
						>
							Tail
						</Button>
					</CardContent>
				</Card>
			))}
		</div>
	);
}

export type WorkflowDispatchResult = {
	ok?: boolean;
	instance_id?: string;
	workflow?: string;
	state?: string;
	error?: string;
};

export function WorkflowDispatchCard({
	result,
}: {
	result: WorkflowDispatchResult;
}) {
	const ok = result.ok !== false && !result.error;
	const tone = ok ? "success" : "error";
	return (
		<Card className="w-full border-l-2" style={{ borderLeftColor: `var(--color-${tone})` }}>
			<CardContent className="flex items-center gap-4 py-3">
				<Badge tone={tone} className="px-2 py-0">
					{ok ? (result.state ?? "dispatched") : "failed"}
				</Badge>
				<div className="min-w-0 flex-1">
					<div className="text-[13px] font-bold tracking-tight">
						{result.workflow ?? "System Workflow"}
					</div>
					{result.instance_id && (
						<div className="mt-0.5 font-mono text-[10px] uppercase tracking-tighter text-[var(--color-foreground-faint)]">
							Instance ID: {result.instance_id.slice(0, 16)}
						</div>
					)}
					{result.error && (
						<div className="mt-2 flex items-start gap-2 rounded-lg bg-[var(--color-error-soft)]/20 p-2 font-mono text-[11px] text-[var(--color-error)]">
							<span className="leading-relaxed">{result.error}</span>
						</div>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
