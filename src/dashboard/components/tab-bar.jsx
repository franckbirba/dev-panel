export function TabBar({ activeTab, onTabChange, stats, activeFilter, onFilterChange }) {
  const pendingCount = stats?.pending || 0;
  const bugCount = stats?.bugs || 0;
  const featureCount = stats?.features || 0;

  const tabs = [
    { id: "inbox", label: "Inbox", badge: pendingCount || null },
    { id: "dashboard", label: "Dashboard" },
    { id: "settings", label: "Settings" },
  ];

  const filters = [
    { id: "bug", label: "Bugs", count: bugCount, color: "bg-error" },
    { id: "feature", label: "Features", count: featureCount, color: "bg-info" },
    { id: "pending", label: "Pending", count: pendingCount, color: "bg-warning" },
  ];

  return (
    <div className="flex items-center h-12 border-b border-border bg-surface px-1">
      <div className="flex items-center gap-1 px-3">
        <span className="text-[10px] font-mono font-bold tracking-widest text-muted-foreground/60 uppercase mr-2">DP</span>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`relative px-3 py-1.5 text-[13px] rounded-md cursor-pointer flex items-center gap-2 transition-colors ${
              activeTab === tab.id
                ? "tab-active bg-secondary text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
            }`}
          >
            {tab.label}
            {tab.badge != null && (
              <span className="flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-success/15 text-success text-[10px] font-mono font-bold">
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="flex-1" />
      {activeTab === "inbox" && (
        <div className="flex gap-1 pr-3">
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => onFilterChange(f.id)}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md cursor-pointer transition-colors ${
                activeFilter === f.id
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${f.color}`} />
              {f.label}
              {f.count > 0 && <span className="text-muted-foreground/60 font-mono text-[10px]">{f.count}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
