import { useState, useEffect, useCallback } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { TicketRow } from "@/components/ticket-row";
import { TicketDetail } from "@/components/ticket-detail";

function ConfirmModal({ action, count, onConfirm, onCancel }) {
  const label = action === "publish" ? "Publish" : "Reject";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-xl shadow-lg p-6 w-[380px] flex flex-col gap-4">
        <h3 className="text-foreground text-[15px] font-semibold">
          {label} {count} ticket{count > 1 ? "s" : ""}?
        </h3>
        <p className="text-muted-foreground text-[13px]">
          This will {action === "publish" ? "publish selected tickets to GitHub" : "reject selected tickets"}.
          This action cannot be undone.
        </p>
        <div className="flex gap-3 justify-end">
          <Button variant="outline" onClick={onCancel} className="cursor-pointer">
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            className={`cursor-pointer font-semibold ${
              action === "publish"
                ? "bg-success hover:bg-success/90 text-background"
                : "bg-error hover:bg-error/90 text-background"
            }`}
          >
            {label} {count} ticket{count > 1 ? "s" : ""}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function InboxView({ apiUrl, apiKey, filter, refreshKey }) {
  const [tickets, setTickets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkMode, setBulkMode] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [bulkLoading, setBulkLoading] = useState(false);

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

  const toggleCheck = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const pendingTickets = tickets.filter((t) => t.status === "pending");

  const toggleSelectAll = useCallback(() => {
    const pendingIds = pendingTickets.map((t) => t.id);
    setSelectedIds((prev) => {
      const allSelected = pendingIds.every((id) => prev.has(id));
      return allSelected ? new Set() : new Set(pendingIds);
    });
  }, [pendingTickets]);

  function exitBulkMode() {
    setBulkMode(false);
    setSelectedIds(new Set());
  }

  async function executeBulkAction(action) {
    setConfirmAction(null);
    setBulkLoading(true);
    try {
      const ids = [...selectedIds];
      const res = await fetch(`${apiUrl}/api/tickets/bulk`, {
        method: "POST",
        headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids }),
      });
      const result = await res.json();
      if (res.ok) {
        const newStatus = action === "publish" ? "published" : "rejected";
        const succeededIds = new Set(
          action === "publish" ? result.succeeded.map((s) => s.id) : result.succeeded
        );
        setTickets((prev) =>
          prev.map((t) => (succeededIds.has(t.id) ? { ...t, status: newStatus } : t))
        );
        if (selectedId && succeededIds.has(selectedId)) {
          setSelectedTicket((prev) => (prev ? { ...prev, status: newStatus } : null));
        }
      }
    } catch (e) {
      console.error("Bulk action failed:", e);
    } finally {
      setBulkLoading(false);
      exitBulkMode();
    }
  }

  const bugCount = tickets.filter((t) => t.type === "bug").length;
  const featureCount = tickets.filter((t) => t.type === "feature").length;
  const pendingCount = pendingTickets.length;
  const checkedPendingCount = [...selectedIds].filter((id) =>
    pendingTickets.some((t) => t.id === id)
  ).length;

  return (
    <div className="flex h-full overflow-hidden">
      {confirmAction && (
        <ConfirmModal
          action={confirmAction}
          count={selectedIds.size}
          onConfirm={() => executeBulkAction(confirmAction)}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {/* Ticket list panel */}
      <div className="w-[420px] border-r border-border bg-surface flex flex-col">
        {/* List header with counters */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50">
          <span className="text-foreground text-[13px] font-semibold tracking-wide">Tickets</span>
          <span className="text-muted-foreground/40 text-[11px] font-mono">{tickets.length}</span>
          <div className="flex-1" />
          {pendingCount > 0 && !bulkMode && (
            <button
              onClick={() => setBulkMode(true)}
              className="text-info text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-info/10 hover:bg-info/20 cursor-pointer transition-colors"
            >
              Select
            </button>
          )}
          {pendingCount > 0 && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-warning/10 text-warning text-[10px] font-mono font-bold">
              <span className="w-1 h-1 rounded-full bg-warning animate-pulse" />
              {pendingCount} pending
            </span>
          )}
        </div>

        {/* Bulk action bar */}
        {bulkMode && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border/50 bg-info/5">
            <input
              type="checkbox"
              checked={pendingTickets.length > 0 && pendingTickets.every((t) => selectedIds.has(t.id))}
              onChange={toggleSelectAll}
              className="w-3.5 h-3.5 rounded border-border accent-info cursor-pointer"
            />
            <span className="text-muted-foreground text-[11px] font-mono">
              {checkedPendingCount} selected
            </span>
            <div className="flex-1" />
            <Button
              size="sm"
              disabled={checkedPendingCount === 0 || bulkLoading}
              onClick={() => setConfirmAction("publish")}
              className="h-6 px-2 text-[10px] font-mono bg-success hover:bg-success/90 text-background cursor-pointer disabled:opacity-40"
            >
              {bulkLoading ? "..." : "Publish"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={checkedPendingCount === 0 || bulkLoading}
              onClick={() => setConfirmAction("reject")}
              className="h-6 px-2 text-[10px] font-mono cursor-pointer disabled:opacity-40"
            >
              Reject
            </Button>
            <button
              onClick={exitBulkMode}
              className="text-muted-foreground/50 text-[10px] font-mono hover:text-foreground cursor-pointer ml-1"
            >
              Cancel
            </button>
          </div>
        )}

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
                    selectable={bulkMode && t.status === "pending"}
                    checked={selectedIds.has(t.id)}
                    onCheck={toggleCheck}
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
