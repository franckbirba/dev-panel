import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { StatusChip } from "./status-chip";

function InfoRow({ label, value }) {
  return (
    <div className="flex gap-3">
      <span className="text-muted-foreground/60 text-xs min-w-[80px] shrink-0">{label}</span>
      <span className="text-muted-foreground text-xs font-mono truncate">{value}</span>
    </div>
  );
}

export function TicketDetail({ ticket, apiUrl, apiKey, onAction }) {
  const [publishing, setPublishing] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  if (!ticket) {
    return (
      <div className="flex items-center justify-center h-full empty-state">
        <span className="text-muted-foreground/30 font-mono text-[13px]">Select a ticket</span>
      </div>
    );
  }

  const context = typeof ticket.context === "string"
    ? JSON.parse(ticket.context || "{}")
    : ticket.context || {};
  const isPending = ticket.status === "pending";

  async function handlePublish() {
    setPublishing(true);
    try {
      const res = await fetch(`${apiUrl}/api/tickets/${ticket.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onAction?.("published", ticket.id, data);
    } catch (err) {
      alert("Publish failed: " + err.message);
    } finally {
      setPublishing(false);
    }
  }

  async function handleReject() {
    setRejecting(true);
    try {
      const res = await fetch(`${apiUrl}/api/tickets/${ticket.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify({ reason: "Not applicable" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onAction?.("rejected", ticket.id, data);
    } catch (err) {
      alert("Reject failed: " + err.message);
    } finally {
      setRejecting(false);
    }
  }

  return (
    <div className="flex flex-col gap-5 p-8 overflow-y-auto h-full max-w-3xl">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-muted-foreground/50 text-[11px] font-mono">
          DP-{String(ticket.id).padStart(4, "0")}
        </div>
        <h2 className="text-foreground text-xl font-bold tracking-tight leading-tight">{ticket.title}</h2>
        <div className="flex gap-2 items-center">
          <StatusChip type={ticket.type} />
          <StatusChip type={ticket.status} label={ticket.status} />
        </div>
      </div>

      <Separator className="bg-border/50" />

      <p className="text-muted-foreground text-sm leading-relaxed whitespace-pre-wrap">
        {ticket.description}
      </p>

      {ticket.has_screenshot && (
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground/60 text-[11px] font-mono uppercase tracking-wider">Screenshot</span>
          <img
            src={`${apiUrl}/api/tickets/${ticket.id}/screenshot?api_key=${apiKey}`}
            className="max-w-full rounded-lg border border-border"
            alt="Screenshot"
          />
        </div>
      )}

      {context.userAgent && (
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground/60 text-[11px] font-mono uppercase tracking-wider">System Info</span>
          <div className="bg-secondary/50 rounded-lg p-4 flex flex-col gap-2 border border-border/50">
            {context.url && <InfoRow label="URL" value={context.url} />}
            {context.userAgent && <InfoRow label="User Agent" value={context.userAgent} />}
            {context.viewport && <InfoRow label="Viewport" value={`${context.viewport.width}×${context.viewport.height}`} />}
          </div>
        </div>
      )}

      {isPending && (
        <div className="flex gap-3 mt-1">
          <Button
            onClick={handlePublish}
            disabled={publishing || rejecting}
            className="bg-success hover:bg-success/90 text-background font-semibold cursor-pointer"
          >
            {publishing ? "Publishing..." : "Publish to GitHub"}
          </Button>
          <Button
            variant="outline"
            onClick={handleReject}
            disabled={publishing || rejecting}
            className="cursor-pointer"
          >
            Reject
          </Button>
        </div>
      )}

      {ticket.github_issue_url && (
        <a
          href={ticket.github_issue_url}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1.5 text-success text-xs font-mono no-underline hover:underline"
        >
          → GitHub Issue #{ticket.github_issue_number}
        </a>
      )}
    </div>
  );
}
