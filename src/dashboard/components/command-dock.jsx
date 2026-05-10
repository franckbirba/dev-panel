// src/dashboard/components/command-dock.jsx
// Status bar: 1 line, monospace, just the essentials.
// Wireframe pattern: project · view · worker totals · shelly state · ⌘K · live.
const VIEW_LABELS = {
  signals: 'Signals', today: 'Today', captures: 'Inbox', inbox: 'Inbox',
  dashboard: 'Dashboard', projects: 'Projects', queues: 'Queues',
  shelly: 'Shelly', settings: 'Settings', fleet: 'Fleet', memory: 'Memory',
};

// Sum the per-queue counts streamed via the `queue:update` SSE event into a
// single worker-level snapshot. Returns null when no health frame has arrived
// yet so the caller can decide whether to render the segment at all.
function workerTotals(queueHealth) {
  if (!queueHealth?.queues || !Array.isArray(queueHealth.queues)) return null;
  let active = 0, waiting = 0, failed = 0;
  for (const q of queueHealth.queues) {
    if (!q?.counts) continue;
    active  += q.counts.active  || 0;
    waiting += q.counts.waiting || 0;
    failed  += q.counts.failed  || 0;
  }
  return { active, waiting, failed };
}

export function CommandDock({
  projectName, sseConnected, ticketCount, activeTab, queueHealth, shellyStatus,
}) {
  const w = workerTotals(queueHealth);
  return (
    <div className="status-bar">
      <span>{projectName || 'dev-panel'}</span>
      <span className="opacity-40">/</span>
      <span>{VIEW_LABELS[activeTab] || ''}</span>
      {ticketCount != null && (
        <>
          <span className="opacity-40">·</span>
          <span>{ticketCount} tickets</span>
        </>
      )}
      {w && (
        <>
          <span className="opacity-40">·</span>
          <span>worker: {w.active} active · {w.waiting} wait{w.failed ? ` · ${w.failed} failed` : ''}</span>
        </>
      )}
      {shellyStatus && (
        <>
          <span className="opacity-40">·</span>
          <span>
            shelly:&nbsp;
            <span style={{ color: shellyStatus.healthy ? 'var(--color-success)' : 'var(--color-error)' }}>
              {shellyStatus.healthy ? 'awake' : 'down'}
            </span>
          </span>
        </>
      )}
      <div className="flex-1" />
      <span className="hidden md:inline opacity-60">⌘K</span>
      <span className="opacity-40 hidden md:inline">·</span>
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${sseConnected ? 'bg-[var(--color-success)] animate-glow-pulse' : 'bg-[var(--color-error)]'}`} />
        <span>{sseConnected ? 'live' : 'disconnected'}</span>
      </div>
    </div>
  );
}
