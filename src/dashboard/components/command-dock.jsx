// src/dashboard/components/command-dock.jsx
// Status bar: 1 line, monospace, just the essentials.
const VIEW_LABELS = {
  signals: 'Signals', today: 'Today', captures: 'Inbox', inbox: 'Inbox',
  dashboard: 'Dashboard', projects: 'Projects', queues: 'Queues',
  shelly: 'Shelly', settings: 'Settings',
};

export function CommandDock({ projectName, sseConnected, ticketCount, activeTab }) {
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
