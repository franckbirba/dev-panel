"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export type GlitchTipException = {
	type?: string | null;
	value?: string | null;
	module?: string | null;
};

export type GlitchTipFrame = {
	filename?: string;
	function?: string;
	lineno?: number;
};

export type GlitchTipLastEvent = {
	message?: string | null;
	exception?: GlitchTipException[] | null;
	stack?: GlitchTipFrame[] | null;
	tags?: Array<[string, string]> | null;
};

export type GlitchTipIssue = {
	id?: string | number;
	title?: string;
	culprit?: string | null;
	level?: string;
	status?: string;
	count?: number | string;
	first_seen?: string;
	last_seen?: string;
	last_event?: GlitchTipLastEvent | null;
};

function toneForLevel(level?: string) {
	if (level === "error" || level === "fatal") return "error" as const;
	if (level === "warning") return "warning" as const;
	if (level === "info") return "info" as const;
	return "neutral" as const;
}

export function GlitchTipIssueCard({
	issue,
	orgSlug,
	onResolve,
}: {
	issue: GlitchTipIssue;
	orgSlug?: string;
	onResolve?: (issueId: string) => void;
}) {
	const issueId = issue.id !== undefined ? String(issue.id) : "";
	const tone = toneForLevel(issue.level);
	const firstException = issue.last_event?.exception?.[0];
	const stackHead = (issue.last_event?.stack ?? []).slice(0, 3);

	return (
		<Card className="w-full">
			<CardHeader className="flex-row items-center justify-between gap-2 py-2">
				<div className="flex min-w-0 flex-col">
					<span className="truncate text-[12.5px] font-semibold">
						{issue.title || "GlitchTip issue"}
					</span>
					{issue.culprit && (
						<span className="truncate font-mono text-[11px] text-[var(--color-foreground-muted)]">
							{issue.culprit}
						</span>
					)}
				</div>
				<div className="flex items-center gap-1">
					{issue.level && <Badge tone={tone}>{issue.level}</Badge>}
					{issue.status && <Badge tone="neutral">{issue.status}</Badge>}
				</div>
			</CardHeader>
			<CardContent className="space-y-2 pb-3 pt-0">
				{firstException?.value && (
					<p className="text-[12px]">
						<span className="font-mono">{firstException.type ?? "Error"}:</span>{" "}
						{firstException.value}
					</p>
				)}
				{stackHead.length > 0 && (
					<pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 font-mono text-[11px] text-[var(--color-foreground-muted)]">
						{stackHead.map((f) => {
							const key = `${f.filename ?? "?"}:${f.lineno ?? "?"}:${f.function ?? "?"}`;
							return (
								<div key={key}>
									{f.function ? `${f.function}` : ""}
									{f.filename
										? ` (${f.filename}${f.lineno ? ":" + f.lineno : ""})`
										: ""}
								</div>
							);
						})}
					</pre>
				)}
				<div className="flex items-center gap-2 pt-1">
					{issueId && (
						<Button
							size="sm"
							variant="default"
							className="h-7 px-2 text-[11px]"
							onClick={() => onResolve?.(issueId)}
						>
							Resolve
						</Button>
					)}
					{orgSlug && issueId && (
						<a
							href={`https://glitchtip.devpanl.dev/${orgSlug}/issues/${issueId}/`}
							target="_blank"
							rel="noreferrer noopener"
							className="font-mono text-[11px] text-[var(--color-brand)] hover:underline"
						>
							open in glitchtip
						</a>
					)}
					{issue.count !== undefined && (
						<span className="ml-auto font-mono text-[11px] text-[var(--color-foreground-muted)]">
							{issue.count} events
						</span>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
