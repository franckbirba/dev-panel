import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { StatusChip } from "./status-chip";
import { ScrollArea } from "@/components/ui/scroll-area";

const roleStyles = {
  user: "bg-info/10 text-info",
  agent: "bg-warning/10 text-warning",
  admin: "bg-success/10 text-success",
  system: "bg-muted text-muted-foreground",
};

function MessageBubble({ message }) {
  const time = message.created_at ? new Date(message.created_at).toLocaleTimeString() : "";
  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex items-center gap-2">
        <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${roleStyles[message.role] || roleStyles.system}`}>
          {message.author || message.role}
        </span>
        <span className="text-muted-foreground/40 text-[10px] font-mono">{time}</span>
        {message.github_comment_id && (
          <span className="text-muted-foreground/30 text-[9px] font-mono">via GitHub</span>
        )}
      </div>
      <p className="text-foreground/80 text-[13px] leading-relaxed whitespace-pre-wrap pl-1">
        {message.content}
      </p>
    </div>
  );
}

function MessageThread({ ticketId, apiUrl, apiKey }) {
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    if (!ticketId) return;
    fetch(`${apiUrl}/api/tickets/${ticketId}/messages`, {
      headers: { "X-API-Key": apiKey },
    })
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((data) => setMessages(data.messages || []))
      .catch(() => setMessages([]));
  }, [ticketId, apiUrl, apiKey]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(e) {
    e.preventDefault();
    if (!newMessage.trim()) return;
    setSending(true);
    try {
      const res = await fetch(`${apiUrl}/api/tickets/${ticketId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify({ role: "admin", content: newMessage.trim() }),
      });
      if (res.ok) {
        const msg = await res.json();
        setMessages((prev) => [...prev, msg]);
        setNewMessage("");
      }
    } catch { /* ignore */ }
    setSending(false);
  }

  async function handleSyncComments() {
    setSyncing(true);
    try {
      await fetch(`${apiUrl}/api/tickets/${ticketId}/sync-comments`, {
        method: "POST",
        headers: { "X-API-Key": apiKey },
      });
      // Refresh messages
      const res = await fetch(`${apiUrl}/api/tickets/${ticketId}/messages`, {
        headers: { "X-API-Key": apiKey },
      });
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
      }
    } catch { /* ignore */ }
    setSyncing(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground/60 text-[11px] font-mono uppercase tracking-wider">Messages</span>
        <div className="flex-1 h-px bg-border/50" />
        <button
          onClick={handleSyncComments}
          disabled={syncing}
          className="text-[10px] font-mono text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-50"
        >
          {syncing ? "Syncing..." : "Sync GitHub"}
        </button>
      </div>
      <ScrollArea className="max-h-[300px]">
        {messages.length === 0 ? (
          <div className="empty-state flex items-center justify-center py-6 rounded-lg">
            <span className="text-muted-foreground/50 text-xs font-mono">No messages yet</span>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-border/30">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </ScrollArea>
      <form onSubmit={handleSend} className="flex gap-2">
        <input
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          placeholder="Reply..."
          className="flex-1 h-8 px-3 rounded-lg border border-border bg-background text-foreground font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring/40 transition-all placeholder:text-muted-foreground/40"
        />
        <Button type="submit" disabled={sending || !newMessage.trim()} className="h-8 text-xs cursor-pointer">
          Send
        </Button>
      </form>
    </div>
  );
}

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

      <Separator className="bg-border/50" />
      <MessageThread ticketId={ticket.id} apiUrl={apiUrl} apiKey={apiKey} />

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
