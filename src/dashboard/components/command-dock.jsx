export function CommandDock({ projectName, sseConnected, ticketCount }) {
  return (
    <div className="status-bar flex items-center h-8 px-4 border-t border-border gap-4">
      <span className="text-muted-foreground/50 text-[10px] font-mono">{projectName || "dev-panel"}</span>
      <span className="text-border text-[10px]">·</span>
      <span className="text-muted-foreground/50 text-[10px] font-mono">{ticketCount || 0} tickets</span>
      <div className="flex-1" />
      <div className="flex items-center gap-1.5">
        <span className={`w-1 h-1 rounded-full ${sseConnected ? "bg-success animate-pulse" : "bg-error"}`} />
        <span className="text-muted-foreground/40 text-[10px] font-mono">
          {sseConnected ? "live" : "disconnected"}
        </span>
      </div>
    </div>
  );
}
