import { useState } from "react";

function NavItem({ label, active, danger, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`block w-full text-left px-3 py-2 rounded-lg text-[13px] cursor-pointer border-0 transition-colors ${
        active ? "bg-secondary text-foreground font-medium" : "bg-transparent hover:bg-secondary/50"
      } ${danger ? "text-destructive" : active ? "" : "text-muted-foreground"}`}
    >
      {label}
    </button>
  );
}

function FieldDisplay({ label, value }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted-foreground/60 text-[11px] font-mono uppercase tracking-wider">{label}</span>
      <div className="px-3 py-2.5 bg-secondary/50 rounded-lg border border-border/50 text-foreground text-[13px] font-mono">
        {value || "—"}
      </div>
    </div>
  );
}

export function SettingsView({ apiUrl, apiKey }) {
  const [section, setSection] = useState("project");

  const sections = [
    { id: "project", label: "Project" },
    { id: "github", label: "GitHub" },
    { id: "notifications", label: "Notifications" },
    { id: "storage", label: "Storage" },
    { id: "danger", label: "Danger Zone", danger: true },
  ];

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="w-[220px] p-4 border-r border-border bg-surface">
        <div className="flex flex-col gap-0.5">
          {sections.map((s) => (
            <NavItem
              key={s.id}
              label={s.label}
              active={section === s.id}
              danger={s.danger}
              onClick={() => setSection(s.id)}
            />
          ))}
        </div>
      </div>
      <div className="flex-1 p-8 overflow-y-auto flex flex-col gap-6 max-w-2xl">
        <div className="flex flex-col gap-1">
          <h2 className="text-foreground text-xl font-bold tracking-tight">
            {sections.find((s) => s.id === section)?.label}
          </h2>
          <p className="text-muted-foreground/60 text-[13px]">
            Configuration is read-only. Edit .devpanelrc.json or use the CLI.
          </p>
        </div>
        {section === "project" && (
          <div className="flex flex-col gap-5">
            <FieldDisplay label="API URL" value={apiUrl} />
            <FieldDisplay label="API Key" value={apiKey ? apiKey.slice(0, 8) + "..." : "—"} />
            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground/60 text-[11px] font-mono uppercase tracking-wider">Admin Key (optional)</span>
              <p className="text-muted-foreground/40 text-[11px]">Required for queue admin actions (pause, retry, clean).</p>
              <input
                type="password"
                defaultValue={localStorage.getItem("devpanel_admin_key") || ""}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  if (v) localStorage.setItem("devpanel_admin_key", v);
                  else localStorage.removeItem("devpanel_admin_key");
                }}
                placeholder="admin key..."
                autoComplete="off"
                className="h-9 px-3 rounded-lg border border-border bg-background text-foreground font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring/60 transition-all placeholder:text-muted-foreground/40"
              />
            </div>
          </div>
        )}
        {section === "github" && (
          <div className="flex flex-col gap-5">
            <FieldDisplay label="Repository" value="Configure in .devpanelrc.json" />
            <FieldDisplay label="Token" value="Set via GITHUB_TOKEN env var" />
          </div>
        )}
        {section === "storage" && (
          <div className="flex flex-col gap-5">
            <FieldDisplay label="Storage Path" value="./storage" />
            <FieldDisplay label="Max File Size" value="10MB" />
          </div>
        )}
      </div>
    </div>
  );
}
