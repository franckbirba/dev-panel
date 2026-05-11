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
				<CardContent className="py-2 text-[12px] text-[var(--color-foreground-muted)]">
					No workflow instances match.
				</CardContent>
			</Card>
		);
	}
	return (
		<div className="my-2 flex w-full flex-col gap-2">
			{instances.map((inst) => (
				<Card key={inst.instance_id} className="w-full">
					<CardContent className="flex items-center gap-2 py-2">
						<Badge tone={toneForState(inst.state)}>
							{inst.state ?? "pending"}
						</Badge>
						<div className="min-w-0 flex-1">
							<div className="flex items-baseline gap-2">
								<span className="text-[12.5px] font-semibold">
									{inst.workflow}
								</span>
								{inst.current_step && (
									<span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
										{inst.current_step}
									</span>
								)}
							</div>
							<div className="font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
								{inst.repo && (
									<span>
										{inst.repo}
										{inst.pr_number ? `#${inst.pr_number}` : ""}
										{" · "}
									</span>
								)}
								{inst.work_item_id && <span>{inst.work_item_id} · </span>}
								<span>{inst.instance_id.slice(0, 8)}</span>
							</div>
						</div>
						<Button
							size="sm"
							variant="ghost"
							className="h-6 px-2 text-[11px]"
							onClick={() => onTail?.(inst.instance_id)}
						>
							tail
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
	return (
		<Card
			className={`w-full ${
				ok
					? "border-[var(--color-success)]/40"
					: "border-[var(--color-error)]/40"
			}`}
		>
			<CardContent className="flex items-center gap-2 py-2">
				<Badge tone={ok ? "success" : "error"}>
					{ok ? (result.state ?? "dispatched") : "failed"}
				</Badge>
				<div className="min-w-0 flex-1">
					<div className="text-[12.5px] font-semibold">
						{result.workflow ?? "Workflow"}
					</div>
					{result.instance_id && (
						<div className="font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
							instance {result.instance_id.slice(0, 12)}
						</div>
					)}
					{result.error && (
						<p className="mt-1 text-[11.5px] text-[var(--color-error)]">
							{result.error}
						</p>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
