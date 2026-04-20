import { useState, useEffect } from "react";
import {
  listLocalProjects, getCurrentProjectId, setCurrentProject, getAdminKey
} from "@/lib/projects-store";

// Compact horizontal strip showing every known project's pulse: name,
// in-flight workflow count, healthy/down dot. Click = switch.
// Pulls from /api/projects/summary if admin key is set; otherwise per-project
// /api/whoami calls (slower, parallel).
export function ProjectRibbon({ apiUrl, refreshKey, onSwitch }) {
  const [data, setData] = useState({});
  const localProjects = listLocalProjects();
  const adminKey = getAdminKey();
  const currentId = getCurrentProjectId();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (adminKey) {
        try {
          const r = await fetch(`${apiUrl}/api/projects/summary`, {
            headers: { 'X-Admin-Key': adminKey }
          });
          if (!r.ok) return;
          const { projects } = await r.json();
          if (cancelled) return;
          const map = {};
          for (const p of projects) map[p.id] = p;
          setData(map);
        } catch { /* ignore */ }
      } else {
        const map = {};
        await Promise.all(localProjects.map(async p => {
          try {
            const r = await fetch(`${apiUrl}/api/whoami`, { headers: { 'X-API-Key': p.api_key } });
            if (r.ok) map[p.id] = await r.json();
          } catch { /* ignore */ }
        }));
        if (!cancelled) setData(map);
      }
    }
    load();
    const id = setInterval(load, 12_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [apiUrl, adminKey, refreshKey, localProjects.length]);

  if (localProjects.length <= 1) return null;

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-surface/50 overflow-x-auto">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mr-2">team</span>
      {localProjects.map(p => {
        const summary = data[p.id];
        const inFlight = summary?.active_workflows ?? 0;
        const isCurrent = p.id === currentId;
        const healthy = !!summary;
        const dotClass = !healthy
          ? "bg-muted-foreground/30"
          : inFlight > 0 ? "bg-warning animate-pulse" : "bg-success";
        return (
          <button
            key={p.id}
            onClick={() => { setCurrentProject(p.id); onSwitch?.(p.id); }}
            title={`${p.name}${summary?.github_repo ? " — " + summary.github_repo : ""}${inFlight ? ` — ${inFlight} in-flight` : ""}`}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] cursor-pointer transition-colors ${
              isCurrent
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
            <span className="font-mono whitespace-nowrap">{p.name}</span>
            {inFlight > 0 && (
              <span className="ml-1 px-1 rounded bg-warning/15 text-warning text-[9px] font-mono font-bold tabular-nums">
                {inFlight}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
