"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export type PlanePage = {
	id: string;
	name: string;
	access?: number | null;
	archived_at?: string | null;
	color?: string | null;
};

export function PageListCard({
	pages,
	project,
	onOpen,
}: {
	pages: PlanePage[];
	project?: string;
	onOpen?: (pageId: string) => void;
}) {
	if (pages.length === 0) {
		return (
			<Card className="w-full">
				<CardContent className="py-2 text-[12px] text-[var(--color-foreground-muted)]">
					No pages on {project ?? "this project"}.
				</CardContent>
			</Card>
		);
	}
	return (
		<Card className="w-full">
			<CardHeader className="py-2">
				<span className="text-[12.5px] font-semibold">
					Pages
					{project && (
						<span className="ml-2 font-mono text-[11px] text-[var(--color-foreground-muted)]">
							{project}
						</span>
					)}
				</span>
			</CardHeader>
			<CardContent className="space-y-1 pb-2 pt-0">
				{pages.map((p) => (
					<div
						key={p.id}
						className="flex items-center gap-2 border-t border-[var(--color-border)] pt-1 first:border-t-0 first:pt-0"
					>
						<div className="min-w-0 flex-1">
							<div className="truncate text-[12.5px]">{p.name}</div>
							<div className="font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
								{p.id.slice(0, 12)}
								{p.archived_at && " · archived"}
							</div>
						</div>
						{p.access === 1 && <Badge tone="neutral">private</Badge>}
						<Button
							size="sm"
							variant="ghost"
							className="h-6 px-2 text-[11px]"
							onClick={() => onOpen?.(p.id)}
						>
							open
						</Button>
					</div>
				))}
			</CardContent>
		</Card>
	);
}

export type PlanePageContent = {
	id?: string;
	name?: string;
	description_html?: string;
	description_markdown?: string;
};

// We accept HTML but render markdown. The MCP `plane_get_page_html` returns
// HTML; the LLM may also paraphrase to markdown when summarising. Either
// way, the assistant-ui MarkdownText component handles the markdown form,
// and we fall back to raw HTML if no markdown is present.
function htmlToText(html?: string) {
	if (!html) return "";
	return html
		.replace(/<\/(p|h[1-6]|li|tr|div)>/gi, "\n")
		.replace(/<br\s*\/?\s*>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function PageContentCard({ page }: { page: PlanePageContent }) {
	const md = page.description_markdown ?? htmlToText(page.description_html);
	return (
		<Card className="w-full">
			<CardHeader className="py-2">
				<span className="text-[12.5px] font-semibold">
					{page.name ?? "Page"}
				</span>
				{page.id && (
					<span className="font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
						{page.id.slice(0, 12)}
					</span>
				)}
			</CardHeader>
			<CardContent className="pb-3 pt-0 text-[12.5px]">
				{md ? (
					<pre className="max-h-[480px] overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12.5px]">
						{md}
					</pre>
				) : (
					<p className="italic text-[var(--color-foreground-muted)]">
						(empty page)
					</p>
				)}
			</CardContent>
		</Card>
	);
}

export type PageMutationResult = {
	ok?: boolean;
	page_id?: string;
	id?: string;
	name?: string;
	action?: "created" | "updated" | "archived" | "deleted";
	url?: string;
};

export function PageMutationCard({ result }: { result: PageMutationResult }) {
	const action = result.action ?? "updated";
	const id = result.page_id ?? result.id;
	return (
		<Card className="w-full border-[var(--color-success)]/40">
			<CardContent className="flex items-center gap-2 py-2">
				<Badge tone="success">{action}</Badge>
				<div className="min-w-0 flex-1">
					<div className="text-[12.5px] font-semibold">
						{result.name ?? "Plane page"}
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

export type PlaneAttachment = {
	id: string;
	name?: string;
	type?: string;
	size?: number;
	asset?: string;
};

function fmtBytes(n?: number) {
	if (n === undefined) return "";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentListCard({
	attachments,
	onDownload,
}: {
	attachments: PlaneAttachment[];
	onDownload?: (attachmentId: string) => void;
}) {
	if (attachments.length === 0) {
		return (
			<Card className="w-full">
				<CardContent className="py-2 text-[12px] text-[var(--color-foreground-muted)]">
					No attachments.
				</CardContent>
			</Card>
		);
	}
	return (
		<Card className="w-full">
			<CardContent className="space-y-1 py-2">
				{attachments.map((a) => (
					<div
						key={a.id}
						className="flex items-center gap-2 border-t border-[var(--color-border)] pt-1 first:border-t-0 first:pt-0"
					>
						<div className="min-w-0 flex-1">
							<div className="truncate text-[12.5px]">
								{a.name ?? a.id.slice(0, 12)}
							</div>
							<div className="font-mono text-[10.5px] text-[var(--color-foreground-faint)]">
								{a.type ?? ""}
								{a.size !== undefined && ` · ${fmtBytes(a.size)}`}
							</div>
						</div>
						<Button
							size="sm"
							variant="ghost"
							className="h-6 px-2 text-[11px]"
							onClick={() => onDownload?.(a.id)}
						>
							download
						</Button>
					</div>
				))}
			</CardContent>
		</Card>
	);
}
