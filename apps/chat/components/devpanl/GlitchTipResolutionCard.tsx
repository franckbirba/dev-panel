"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export type GlitchTipResolutionResult = {
	ok?: boolean;
	id?: string | number;
	status?: string;
	error?: string;
};

export function GlitchTipResolutionCard({
	result,
}: {
	result: GlitchTipResolutionResult;
}) {
	const ok = result.ok !== false && !result.error;
	const tone = ok ? ("success" as const) : ("error" as const);
	const border = ok
		? "border-[var(--color-success)]/40"
		: "border-[var(--color-error)]/40";
	return (
		<Card className={`w-full ${border}`}>
			<CardContent className="flex items-center gap-2 py-2">
				<Badge tone={tone}>
					{ok ? (result.status ?? "resolved") : "error"}
				</Badge>
				<div className="min-w-0 flex-1">
					<p className="text-[12.5px]">
						{ok
							? `Marked issue ${result.id ?? ""} as ${result.status ?? "resolved"}.`
							: result.error || "Resolve failed."}
					</p>
				</div>
			</CardContent>
		</Card>
	);
}
