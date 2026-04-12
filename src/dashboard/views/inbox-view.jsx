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

  return (
    <div className="flex flex-1 overflow-hidden">
      <ScrollArea className="w-[440px] border-r border-border bg-surface">
        <div className="p-2">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-muted-foreground/50 font-mono text-xs">Loading...</div>
          ) : tickets.length === 0 ? (
            <div className="empty-state flex flex-col items-center justify-center py-20 rounded-lg gap-2">
              <span className="text-muted-foreground/30 text-2xl">0</span>
              <span className="text-muted-foreground/50 text-xs font-mono">No tickets</span>
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
      <div className="flex-1 overflow-hidden bg-background">
        <TicketDetail ticket={selectedTicket} apiUrl={apiUrl} apiKey={apiKey} onAction={handleAction} />
      </div>
    </div>
  );
}
