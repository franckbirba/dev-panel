"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export type CancelJobResult = {
	job_id: string;
	action:
		| "killed"
		| "removed"
		| "not_found"
		| "kill_failed"
		| "kill_unreachable";
	ok: boolean;
	prev_state?: string;
	message?: string;
};

// Tiny single-row confirmation card for the `cancel_job` capability.
// Three flavours by action: success (killed/removed), warning (kill
// signal sent but ack pending), error (not_found / unreachable).
//
// We keep the chip set deliberately empty — if Franck wants to follow up
// (tail the killed job, retry, etc.) he sees those affordances on the
// FleetRowCard next time fleet_status runs. Forcing a follow-up chip
// here would mean Shelly has to guess the next intent.

function toneForAction(action: CancelJobResult["action"]) {
	if (action === "killed" || action === "removed") return "success" as const;
	if (action === "kill_failed" || action === "kill_unreachable")
		return "error" as const;
	return "warning" as const;
}

function headlineForAction(action: CancelJobResult["action"]) {
	switch (action) {
		case "killed":
			return "Kill signal sent";
		case "removed":
			return "Removed from queue";
		case "not_found":
			return "Job not found";
		case "kill_failed":
			return "Worker rejected kill";
		case "kill_unreachable":
			return "Worker unreachable";
	}
}

export function CancelJobCard({ result }: { result: CancelJobResult }) {
	const tone = toneForAction(result.action);
	const headline = headlineForAction(result.action);
	const borderTone =
		tone === "success"
			? "border-[var(--color-success)]/50"
			: tone === "error"
				? "border-[var(--color-error)]/50"
				: "border-[var(--color-warning)]/50";
	return (
		<Card className={`w-full ${borderTone}`}>
			<CardContent className="flex items-center gap-3 py-2">
				<Badge tone={tone}>{result.action}</Badge>
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						<span className="text-[12.5px] font-semibold">{headline}</span>
						<span className="truncate font-mono text-[11px] text-[var(--color-foreground-muted)]">
							{result.job_id}
						</span>
					</div>
					{result.message && (
						<p className="text-[11.5px] text-[var(--color-foreground-muted)]">
							{result.message}
						</p>
					)}
				</div>
				{result.prev_state && (
					<span className="font-mono text-[10.5px] uppercase tracking-wide text-[var(--color-foreground-faint)]">
						was {result.prev_state}
					</span>
				)}
			</CardContent>
		</Card>
	);
}
