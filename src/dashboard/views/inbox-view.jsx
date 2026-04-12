import { useState, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TicketRow } from "@/components/ticket-row";
import { TicketDetail } from "@/components/ticket-detail";

export function InboxView({ apiUrl, apiKey, filter, refreshKey }) {
  const [tickets, setTickets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filter === "pending") params.set("status", "pending");
    fetch(`${apiUrl}/api/tickets?${params}`, { headers: { "X-API-Key": apiKey } })
      .then((r) => r.json())
      .then((data) => {
        let list = Array.isArray(data) ? data : data.tickets || [];
        if (filter === "bug" || filter === "feature") {
          list = list.filter((t) => t.type === filter);
        }
        setTickets(list);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [apiUrl, apiKey, filter, refreshKey]);

  useEffect(() => {
    if (!selectedId) { setSelectedTicket(null); return; }
    fetch(`${apiUrl}/api/tickets/${selectedId}`, { headers: { "X-API-Key": apiKey } })
      .then((r) => r.json())
      .then(setSelectedTicket)
      .catch(() => setSelectedTicket(null));
  }, [selectedId, apiUrl, apiKey, refreshKey]);

  function handleAction(action, ticketId) {
    setTickets((prev) =>
      prev.map((t) =>
        t.id === ticketId ? { ...t, status: action === "published" ? "published" : "rejected" } : t
      )
    );
    setSelectedTicket((prev) =>
      prev ? { ...prev, status: action === "published" ? "published" : "rejected" } : null
    );
  }

  const bugCount = tickets.filter((t) => t.type === "bug").length;
  const featureCount = tickets.filter((t) => t.type === "feature").length;
  const pendingCount = tickets.filter((t) => t.status === "pending").length;

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Ticket list panel */}
      <div className="w-[420px] border-r border-border bg-surface flex flex-col">
        {/* List header with counters */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50">
          <span className="text-foreground text-[13px] font-semibold tracking-wide">Tickets</span>
          <span className="text-muted-foreground/40 text-[11px] font-mono">{tickets.length}</span>
          <div className="flex-1" />
          {pendingCount > 0 && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-warning/10 text-warning text-[10px] font-mono font-bold">
              <span className="w-1 h-1 rounded-full bg-warning animate-pulse" />
              {pendingCount} pending
            </span>
          )}
        </div>

        {/* Quick stats ribbon */}
        {tickets.length > 0 && (
          <div className="flex items-center gap-4 px-4 py-2 border-b border-border/30 bg-secondary/20">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-error" />
              <span className="text-muted-foreground/60 text-[10px] font-mono">{bugCount} bugs</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-info" />
              <span className="text-muted-foreground/60 text-[10px] font-mono">{featureCount} features</span>
            </div>
          </div>
        )}

        {/* Ticket list */}
        <ScrollArea className="flex-1">
          <div className="p-2">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-24 gap-3">
                <div className="w-5 h-5 border-2 border-muted-foreground/20 border-t-muted-foreground/60 rounded-full animate-spin" />
                <span className="text-muted-foreground/40 text-xs font-mono">Loading tickets...</span>
              </div>
            ) : tickets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 gap-4">
                <div className="relative">
                  <div className="w-16 h-16 rounded-2xl bg-secondary/50 border border-border/50 flex items-center justify-center">
                    <span className="text-muted-foreground/20 text-2xl font-bold">0</span>
                  </div>
                  <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-success/20 border border-success/30 flex items-center justify-center">
                    <span className="w-1.5 h-1.5 rounded-full bg-success" />
                  </div>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <span className="text-muted-foreground/50 text-[13px] font-medium">All clear</span>
                  <span className="text-muted-foreground/30 text-[11px] font-mono">No tickets to review</span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {tickets.map((t) => (
                  <TicketRow
                    key={t.id}
                    ticket={t}
                    selected={t.id === selectedId}
                    onClick={() => setSelectedId(t.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Detail panel */}
      <div className="flex-1 overflow-hidden bg-background">
        {selectedTicket ? (
          <TicketDetail ticket={selectedTicket} apiUrl={apiUrl} apiKey={apiKey} onAction={handleAction} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div className="relative">
              <div className="w-20 h-20 rounded-2xl border border-border/30 bg-secondary/20 flex items-center justify-center">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground/15">
                  <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
                  <rect x="9" y="3" width="6" height="4" rx="1" />
                  <path d="M9 14h6" />
                  <path d="M9 18h6" />
                </svg>
              </div>
              <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-lg bg-card border border-border/50 flex items-center justify-center">
                <span className="text-muted-foreground/25 text-[10px] font-mono">←</span>
              </div>
            </div>
            <div className="flex flex-col items-center gap-1">
              <span className="text-muted-foreground/30 text-[13px] font-medium">Select a ticket</span>
              <span className="text-muted-foreground/20 text-[11px] font-mono">Click on the left to see details</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
