"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

// GitHub MCP (@modelcontextprotocol/server-github) returns PRs/issues
// roughly as the REST API does (snake_case is the Sentry/GH convention
// but server-github passes them through). We keep field access optional
// so a schema drift doesn't crash the card.

export type GitHubPR = {
	number?: number;
	title?: string;
	state?: string;
	draft?: boolean;
	user?: { login?: string };
	html_url?: string;
	base?: { ref?: string };
	head?: { ref?: string };
	mergeable?: boolean | null;
	mergeable_state?: string;
	created_at?: string;
};

function toneForState(state?: string, draft?: boolean) {
	if (draft) return "neutral" as const;
	if (state === "open") return "success" as const;
	if (state === "closed") return "error" as const;
	if (state === "merged") return "brand" as const;
	return "neutral" as const;
}

export function GitHubPRListCard({
	pulls,
	repo,
	onOpen,
}: {
	pulls: GitHubPR[];
	repo?: string;
	onOpen?: (number: number) => void;
}) {
	if (pulls.length === 0) {
		return (
			<Card className="w-full">
				<CardContent className="py-2 text-[12px] text-[var(--color-foreground-muted)]">
					No PRs found{repo ? ` for ${repo}` : ""}.
				</CardContent>
			</Card>
		);
	}
	return (
		<div className="my-2 flex w-full flex-col gap-2">
			{pulls.slice(0, 20).map((pr) => (
				<Card key={pr.number ?? Math.random()} className="w-full">
					<CardContent className="flex items-center gap-2 py-2">
						<Badge tone={toneForState(pr.state, pr.draft)}>
							{pr.draft ? "draft" : (pr.state ?? "open")}
						</Badge>
						<div className="min-w-0 flex-1">
							<div className="flex items-baseline gap-2">
								<span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
									#{pr.number}
								</span>
								<span className="truncate text-[12.5px] font-semibold">
									{pr.title ?? "(no title)"}
								</span>
							</div>
							<div className="font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
								{pr.user?.login && <span>{pr.user.login} · </span>}
								{pr.head?.ref && pr.base?.ref && (
									<span>
										{pr.head.ref} → {pr.base.ref}
									</span>
								)}
							</div>
						</div>
						{pr.html_url && (
							<a
								href={pr.html_url}
								target="_blank"
								rel="noreferrer noopener"
								className="font-mono text-[11px] text-[var(--color-brand)] hover:underline"
							>
								github
							</a>
						)}
						{pr.number !== undefined && (
							<Button
								size="sm"
								variant="ghost"
								className="h-6 px-2 text-[11px]"
								onClick={() => onOpen?.(pr.number as number)}
							>
								open
							</Button>
						)}
					</CardContent>
				</Card>
			))}
		</div>
	);
}

export function GitHubPRCard({ pr }: { pr: GitHubPR }) {
	return (
		<Card className="w-full">
			<CardHeader className="flex-row items-baseline gap-2 py-2">
				<Badge tone={toneForState(pr.state, pr.draft)}>
					{pr.draft ? "draft" : (pr.state ?? "open")}
				</Badge>
				<span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
					#{pr.number}
				</span>
				<span className="truncate text-[12.5px] font-semibold">
					{pr.title ?? "(no title)"}
				</span>
				{pr.html_url && (
					<a
						href={pr.html_url}
						target="_blank"
						rel="noreferrer noopener"
						className="ml-auto font-mono text-[11px] text-[var(--color-brand)] hover:underline"
					>
						github
					</a>
				)}
			</CardHeader>
			<CardContent className="space-y-1 pb-3 pt-0 text-[12px]">
				{pr.user?.login && (
					<p className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
						by {pr.user.login}
					</p>
				)}
				{pr.head?.ref && pr.base?.ref && (
					<p className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
						{pr.head.ref} → {pr.base.ref}
					</p>
				)}
				{pr.mergeable_state && (
					<p className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
						mergeable: {pr.mergeable_state}
					</p>
				)}
			</CardContent>
		</Card>
	);
}

export type GitHubIssue = {
	number?: number;
	title?: string;
	state?: string;
	user?: { login?: string };
	html_url?: string;
	labels?: Array<{ name?: string }>;
	created_at?: string;
};

export function GitHubIssueListCard({
	issues,
	repo,
}: {
	issues: GitHubIssue[];
	repo?: string;
}) {
	if (issues.length === 0) {
		return (
			<Card className="w-full">
				<CardContent className="py-2 text-[12px] text-[var(--color-foreground-muted)]">
					No issues found{repo ? ` for ${repo}` : ""}.
				</CardContent>
			</Card>
		);
	}
	return (
		<div className="my-2 flex w-full flex-col gap-2">
			{issues.slice(0, 20).map((i) => (
				<Card key={i.number ?? Math.random()} className="w-full">
					<CardContent className="flex items-center gap-2 py-2">
						<Badge tone={i.state === "open" ? "info" : "neutral"}>
							{i.state ?? "open"}
						</Badge>
						<div className="min-w-0 flex-1">
							<div className="flex items-baseline gap-2">
								<span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
									#{i.number}
								</span>
								<span className="truncate text-[12.5px] font-semibold">
									{i.title ?? "(no title)"}
								</span>
							</div>
							{(i.labels ?? []).length > 0 && (
								<div className="flex flex-wrap gap-1 pt-1">
									{(i.labels ?? []).slice(0, 4).map((l, idx) => (
										<span
											key={`${i.number}-${l.name ?? idx}`}
											className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-foreground-muted)]"
										>
											{l.name ?? ""}
										</span>
									))}
								</div>
							)}
						</div>
						{i.html_url && (
							<a
								href={i.html_url}
								target="_blank"
								rel="noreferrer noopener"
								className="font-mono text-[11px] text-[var(--color-brand)] hover:underline"
							>
								github
							</a>
						)}
					</CardContent>
				</Card>
			))}
		</div>
	);
}

export function GitHubIssueCard({ issue }: { issue: GitHubIssue }) {
	return (
		<Card className="w-full">
			<CardHeader className="flex-row items-baseline gap-2 py-2">
				<Badge tone={issue.state === "open" ? "info" : "neutral"}>
					{issue.state ?? "open"}
				</Badge>
				<span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
					#{issue.number}
				</span>
				<span className="truncate text-[12.5px] font-semibold">
					{issue.title ?? "(no title)"}
				</span>
				{issue.html_url && (
					<a
						href={issue.html_url}
						target="_blank"
						rel="noreferrer noopener"
						className="ml-auto font-mono text-[11px] text-[var(--color-brand)] hover:underline"
					>
						github
					</a>
				)}
			</CardHeader>
			<CardContent className="space-y-1 pb-3 pt-0 text-[12px]">
				{issue.user?.login && (
					<p className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
						by {issue.user.login}
					</p>
				)}
				{(issue.labels ?? []).length > 0 && (
					<div className="flex flex-wrap gap-1">
						{(issue.labels ?? []).map((l, idx) => (
							<span
								key={`${issue.number}-${l.name ?? idx}`}
								className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-foreground-muted)]"
							>
								{l.name ?? ""}
							</span>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
