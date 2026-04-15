import { useState, useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TicketRow } from "@/components/ticket-row";
import { TicketDetail } from "@/components/ticket-detail";

const SORT_OPTIONS = [
  { value: "created_at", label: "Date" },
  { value: "title", label: "Title" },
  { value: "type", label: "Type" },
  { value: "status", label: "Status" },
];

export function InboxView({ apiUrl, apiKey, filter, search, sort, order, onParamsChange, refreshKey }) {
  const [tickets, setTickets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [localSearch, setLocalSearch] = useState(search || "");
  const debounceRef = useRef(null);

  useEffect(() => {
    setLocalSearch(search || "");
  }, [search]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (!search) {
      if (filter === "pending") params.set("status", "pending");
      if (filter === "bug" || filter === "feature") params.set("type", filter);
      if (sort) params.set("sort", sort);
      if (order) params.set("order", order);
    }
    fetch(`${apiUrl}/api/tickets?${params}`, { headers: { "X-API-Key": apiKey } })
      .then((r) => r.json())
      .then((data) => {
        const list = Array.isArray(data) ? data : data.tickets || [];
        setTickets(list);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [apiUrl, apiKey, filter, search, sort, order, refreshKey]);

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

  function handleSearchInput(e) {
    const val = e.target.value;
    setLocalSearch(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onParamsChange({ search: val });
    }, 300);
  }

  function handleSearchClear() {
    setLocalSearch("");
    onParamsChange({ search: "" });
  }

  function toggleSortOrder() {
    onParamsChange({ order: order === "desc" ? "asc" : "desc" });
  }

  const bugCount = tickets.filter((t) => t.type === "bug").length;
  const featureCount = tickets.filter((t) => t.type === "feature").length;
  const pendingCount = tickets.filter((t) => t.status === "pending").length;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Ticket list panel */}
      <div className="w-[420px] border-r border-border bg-surface flex flex-col">
        {/* Search bar */}
        <div className="px-3 pt-3 pb-2">
          <div className="relative">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/40">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              value={localSearch}
              onChange={handleSearchInput}
              placeholder="Search tickets..."
              className="w-full h-8 pl-8 pr-8 rounded-md border border-border/50 bg-background text-foreground text-[13px] placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring/40 focus:border-ring/60 transition-all"
            />
            {localSearch && (
              <button onClick={handleSearchClear} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground cursor-pointer">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* List header with counters + sort */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-border/50">
          <span className="text-foreground text-[13px] font-semibold tracking-wide">Tickets</span>
          <span className="text-muted-foreground/40 text-[11px] font-mono">{tickets.length}</span>
          <div className="flex-1" />
          {pendingCount > 0 && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-warning/10 text-warning text-[10px] font-mono font-bold">
              <span className="w-1 h-1 rounded-full bg-warning animate-pulse" />
              {pendingCount} pending
            </span>
          )}
          <select
            value={sort || "created_at"}
            onChange={(e) => onParamsChange({ sort: e.target.value })}
            className="h-6 px-1.5 text-[10px] font-mono rounded border border-border/40 bg-background text-muted-foreground focus:outline-none cursor-pointer"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            onClick={toggleSortOrder}
            className="h-6 w-6 flex items-center justify-center rounded border border-border/40 bg-background text-muted-foreground hover:text-foreground cursor-pointer"
            title={order === "asc" ? "Ascending" : "Descending"}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={`transition-transform ${order === "asc" ? "rotate-180" : ""}`}>
              <path d="M12 5v14" /><path d="m19 12-7 7-7-7" />
            </svg>
          </button>
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
                  <span className="text-muted-foreground/50 text-[13px] font-medium">
                    {search ? "No results" : "All clear"}
                  </span>
                  <span className="text-muted-foreground/30 text-[11px] font-mono">
                    {search ? "Try a different search term" : "No tickets to review"}
                  </span>
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
                <span className="text-muted-foreground/25 text-[10px] font-mono">&larr;</span>
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
