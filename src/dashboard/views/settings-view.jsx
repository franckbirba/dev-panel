import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";

const SECTION_ICONS = {
  project: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  ),
  github: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22" />
    </svg>
  ),
  notifications: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 01-3.46 0" />
    </svg>
  ),
  storage: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  features: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  ),
  danger: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
};

function NavItem({ id, label, active, danger, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2.5 w-full text-left px-3 py-2.5 rounded-lg text-[13px] cursor-pointer transition-all ${
        active
          ? "bg-secondary text-foreground font-medium shadow-sm border border-border/50"
          : "bg-transparent border border-transparent hover:bg-secondary/40"
      } ${danger ? "text-error hover:text-error" : active ? "" : "text-muted-foreground"}`}
    >
      <span className={active ? "text-foreground" : danger ? "text-error/60" : "text-muted-foreground/40"}>
        {SECTION_ICONS[id]}
      </span>
      {label}
    </button>
  );
}

function FieldCard({ label, value, description, mono = true }) {
  return (
    <div className="card-glow rounded-xl p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground/60 text-[11px] font-mono uppercase tracking-wider">{label}</span>
        {description && (
          <span className="text-muted-foreground/30 text-[10px]">{description}</span>
        )}
      </div>
      <div className={`text-foreground text-[13px] ${mono ? "font-mono" : ""} break-all`}>
        {value || <span className="text-muted-foreground/30">—</span>}
      </div>
    </div>
  );
}

function SectionHeader({ title, badge, description }) {
  return (
    <div className="flex flex-col gap-2 mb-2">
      <div className="flex items-center gap-3">
        <h2 className="text-foreground text-lg font-bold tracking-tight">{title}</h2>
        {badge && (
          <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0 text-muted-foreground border-border">
            {badge}
          </Badge>
        )}
      </div>
      {description && (
        <p className="text-muted-foreground/50 text-[12px] leading-relaxed">{description}</p>
      )}
    </div>
  );
}

export function SettingsView({ apiUrl, apiKey }) {
  const [section, setSection] = useState("project");
  const [health, setHealth] = useState(null);

  useEffect(() => {
    fetch(`${apiUrl}/api/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setHealth)
      .catch(() => {});
  }, [apiUrl]);

  const sections = [
    { id: "project", label: "Project" },
    { id: "github", label: "GitHub" },
    { id: "notifications", label: "Notifications" },
    { id: "storage", label: "Storage" },
    { id: "features", label: "Features" },
    { id: "danger", label: "Danger Zone", danger: true },
  ];

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar */}
      <div className="w-[220px] border-r border-border bg-surface flex flex-col">
        <div className="px-4 pt-4 pb-2">
          <span className="text-muted-foreground/40 text-[10px] font-mono uppercase tracking-widest">Settings</span>
        </div>
        <div className="flex flex-col gap-0.5 px-3 pb-4">
          {sections.map((s) => (
            <NavItem
              key={s.id}
              id={s.id}
              label={s.label}
              active={section === s.id}
              danger={s.danger}
              onClick={() => setSection(s.id)}
            />
          ))}
        </div>

        <div className="flex-1" />

        {/* Server status in sidebar footer */}
        <div className="px-4 py-3 border-t border-border/50">
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-1.5 h-1.5 rounded-full ${health?.status === "ok" ? "bg-success animate-pulse" : "bg-error"}`} />
            <span className="text-muted-foreground/50 text-[10px] font-mono">
              {health?.status === "ok" ? "Server healthy" : "Checking..."}
            </span>
          </div>
          <span className="text-muted-foreground/25 text-[9px] font-mono">v2.0.0</span>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-8 max-w-2xl">
          {section === "project" && (
            <>
              <SectionHeader
                title="Project"
                badge="read-only"
                description="Connection details for this DevPanel instance. Edit .devpanelrc.json or use the CLI to change configuration."
              />
              <div className="flex flex-col gap-4 mt-4">
                <FieldCard label="API URL" value={apiUrl} />
                <FieldCard
                  label="API Key"
                  value={apiKey ? apiKey.slice(0, 12) + "..." : null}
                  description="used for project auth"
                />

                <Separator className="bg-border/30 my-2" />

                <div className="card-glow rounded-xl p-4 flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground/60 text-[11px] font-mono uppercase tracking-wider">Admin Key</span>
                    <Badge variant="outline" className="font-mono text-[9px] px-1 py-0 text-warning/60 border-warning/20">
                      optional
                    </Badge>
                  </div>
                  <p className="text-muted-foreground/40 text-[11px] leading-relaxed">
                    Enables queue admin actions — pause, retry, clean. Stored in browser only.
                  </p>
                  <input
                    type="password"
                    defaultValue={localStorage.getItem("devpanel_admin_key") || ""}
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      if (v) localStorage.setItem("devpanel_admin_key", v);
                      else localStorage.removeItem("devpanel_admin_key");
                    }}
                    placeholder="Enter admin key..."
                    autoComplete="off"
                    className="h-9 px-3 rounded-lg border border-border bg-background text-foreground font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring/60 transition-all placeholder:text-muted-foreground/30"
                  />
                </div>
              </div>
            </>
          )}

          {section === "github" && (
            <>
              <SectionHeader
                title="GitHub"
                description="GitHub integration for publishing tickets as issues and syncing comments."
              />
              <div className="flex flex-col gap-4 mt-4">
                <FieldCard label="Repository" value="Configure in .devpanelrc.json" mono={false} />
                <FieldCard label="Token" value="Set via GITHUB_TOKEN env var" mono={false} />
                <div className="card-glow rounded-xl p-4">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground/40 text-[11px] font-mono">Sync</span>
                    <span className="text-muted-foreground/25 text-[10px]">
                      Bidirectional — tickets publish as issues, closed issues sync status back
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}

          {section === "notifications" && (
            <>
              <SectionHeader
                title="Notifications"
                description="Alert channels and notification preferences."
              />
              <div className="flex flex-col gap-4 mt-4">
                <FieldCard label="Telegram" value="Via Shelly webhook" mono={false} />
                <FieldCard label="SSE" value="Real-time events to dashboard" mono={false} />
                <div className="empty-state flex items-center justify-center py-8 rounded-xl">
                  <span className="text-muted-foreground/30 text-[11px] font-mono">More channels coming soon</span>
                </div>
              </div>
            </>
          )}

          {section === "storage" && (
            <>
              <SectionHeader
                title="Storage"
                description="Local SQLite storage configuration."
              />
              <div className="flex flex-col gap-4 mt-4">
                <FieldCard label="Storage Path" value="./storage" />
                <FieldCard label="Max File Size" value="10 MB" />
                <FieldCard label="Screenshot Format" value="BLOB (base64 → binary)" />
                <FieldCard label="Database" value="SQLite via better-sqlite3" mono={false} />
              </div>
            </>
          )}

          {section === "features" && (
            <>
              <SectionHeader
                title="Features"
                description="Try experimental features before they become the default."
              />
              <div className="flex flex-col gap-4 mt-4">
                <div className="card-glow rounded-xl p-4 flex items-center justify-between">
                  <div className="flex flex-col gap-1">
                    <span className="text-foreground text-[13px] font-medium">Signals view</span>
                    <span className="text-muted-foreground/50 text-[11px]">
                      Cross-project signal feed replacing Today/Captures/Dashboard.
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      const current = localStorage.getItem('devpanel_signals_enabled') === 'true';
                      localStorage.setItem('devpanel_signals_enabled', String(!current));
                      window.location.reload();
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-mono cursor-pointer transition-colors ${
                      localStorage.getItem('devpanel_signals_enabled') === 'true'
                        ? 'bg-success/15 text-success'
                        : 'bg-secondary text-muted-foreground'
                    }`}
                  >
                    {localStorage.getItem('devpanel_signals_enabled') === 'true' ? 'ON' : 'OFF'}
                  </button>
                </div>
              </div>
            </>
          )}

          {section === "danger" && (
            <>
              <SectionHeader
                title="Danger Zone"
                description="Destructive actions. Use with caution."
              />
              <div className="flex flex-col gap-4 mt-4">
                <div className="rounded-xl border border-error/20 bg-error/5 p-5 flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="text-error text-[13px] font-semibold">Reset API Key</span>
                    <span className="text-error/50 text-[11px]">Generate a new API key. All connected clients will be disconnected.</span>
                  </div>
                  <button
                    disabled
                    className="self-start px-3 py-1.5 rounded-lg border border-error/30 text-error text-[12px] font-mono opacity-50 cursor-not-allowed"
                  >
                    Use CLI: dev-panel admin reset-key
                  </button>
                </div>
                <div className="rounded-xl border border-error/20 bg-error/5 p-5 flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="text-error text-[13px] font-semibold">Delete All Tickets</span>
                    <span className="text-error/50 text-[11px]">Permanently remove all tickets from this project. Cannot be undone.</span>
                  </div>
                  <button
                    disabled
                    className="self-start px-3 py-1.5 rounded-lg border border-error/30 text-error text-[12px] font-mono opacity-50 cursor-not-allowed"
                  >
                    Use CLI: dev-panel admin purge
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
