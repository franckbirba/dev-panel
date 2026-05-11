"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

// AFFiNE doc list/search results — affine-mcp-server@1.13.0 returns rows
// shaped roughly `{ id, title, parent_id?, updated_at?, ... }`. We keep
// fields optional so a future schema bump doesn't crash the card.
export type AffineDoc = {
	id: string;
	title?: string;
	parent_id?: string | null;
	updated_at?: string;
	primary_mode?: string;
	created_at?: string;
};

export function AffineDocListCard({
	docs,
	workspace,
	onOpen,
}: {
	docs: AffineDoc[];
	workspace?: string;
	onOpen?: (docId: string) => void;
}) {
	if (docs.length === 0) {
		return (
			<Card className="w-full">
				<CardContent className="py-2 text-[12px] text-[var(--color-foreground-muted)]">
					No docs in {workspace ?? "this workspace"}.
				</CardContent>
			</Card>
		);
	}
	return (
		<Card className="w-full">
			<CardHeader className="flex-row items-baseline gap-2 py-2">
				<span className="text-[12.5px] font-semibold">AFFiNE docs</span>
				{workspace && (
					<span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
						{workspace}
					</span>
				)}
				<span className="ml-auto font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
					{docs.length}
				</span>
			</CardHeader>
			<CardContent className="space-y-1 pb-2 pt-0">
				{docs.slice(0, 25).map((d) => (
					<div
						key={d.id}
						className="flex items-center gap-2 border-t border-[var(--color-border)] pt-1 first:border-t-0 first:pt-0"
					>
						<div className="min-w-0 flex-1">
							<div className="truncate text-[12.5px]">
								{d.title ?? "(untitled)"}
							</div>
							<div className="font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
								{d.id.slice(0, 12)}
								{d.updated_at && ` · ${d.updated_at.slice(0, 10)}`}
							</div>
						</div>
						<Button
							size="sm"
							variant="ghost"
							className="h-6 px-2 text-[11px]"
							onClick={() => onOpen?.(d.id)}
						>
							open
						</Button>
					</div>
				))}
				{docs.length > 25 && (
					<div className="pt-1 font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
						… {docs.length - 25} more
					</div>
				)}
			</CardContent>
		</Card>
	);
}

export type AffineDocContent = {
	id?: string;
	title?: string;
	markdown?: string;
	content?: string;
};

export function AffineDocCard({ doc }: { doc: AffineDocContent }) {
	const body = doc.markdown ?? doc.content ?? "";
	return (
		<Card className="w-full">
			<CardHeader className="py-2">
				<span className="text-[12.5px] font-semibold">
					{doc.title ?? "AFFiNE doc"}
				</span>
				{doc.id && (
					<span className="font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
						{doc.id.slice(0, 12)}
					</span>
				)}
			</CardHeader>
			<CardContent className="pb-3 pt-0 text-[12.5px]">
				{body ? (
					<pre className="max-h-[480px] overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12.5px]">
						{body}
					</pre>
				) : (
					<p className="italic text-[var(--color-foreground-muted)]">
						(empty doc)
					</p>
				)}
			</CardContent>
		</Card>
	);
}

export type AffineMutationResult = {
	doc_id?: string;
	id?: string;
	title?: string;
	action?: "created" | "updated" | "appended" | "deleted";
	url?: string;
};

export function AffineMutationCard({
	result,
}: {
	result: AffineMutationResult;
}) {
	const action = result.action ?? "updated";
	const id = result.doc_id ?? result.id;
	return (
		<Card className="w-full border-[var(--color-success)]/40">
			<CardContent className="flex items-center gap-2 py-2">
				<Badge tone="success">{action}</Badge>
				<div className="min-w-0 flex-1">
					<div className="text-[12.5px] font-semibold">
						{result.title ?? "AFFiNE doc"}
					</div>
					{id && (
						<div className="font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
							{id}
						</div>
					)}
				</div>
				{result.url && (
					<a
						href={result.url}
						target="_blank"
						rel="noreferrer noopener"
						className="font-mono text-[11px] text-[var(--color-brand)] hover:underline"
					>
						open
					</a>
				)}
			</CardContent>
		</Card>
	);
}
