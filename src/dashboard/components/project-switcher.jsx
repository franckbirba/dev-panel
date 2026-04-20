import { useState, useRef, useEffect } from "react";
import { listLocalProjects, getCurrentProject, setCurrentProject } from "@/lib/projects-store";

export function ProjectSwitcher({ onSwitch, onManage }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const projects = listLocalProjects();
  const current = getCurrentProject();

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function pick(id) {
    setCurrentProject(id);
    setOpen(false);
    onSwitch?.(id);
  }

  if (!current) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-2.5 py-1 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 cursor-pointer transition-colors"
        title="Switch project"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-success" />
        <span className="font-mono">{current.name}</span>
        <svg viewBox="0 0 12 12" className="w-3 h-3 opacity-60">
          <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 rounded-lg border border-border bg-surface shadow-lg z-50">
          <div className="p-1">
            {projects.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-muted-foreground">No projects yet</div>
            )}
            {projects.map(p => (
              <button
                key={p.id}
                onClick={() => pick(p.id)}
                className={`w-full text-left px-3 py-2 rounded-md text-xs cursor-pointer flex items-center justify-between ${
                  p.id === current.id
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${p.id === current.id ? "bg-success" : "bg-muted-foreground/40"}`} />
                  <span className="font-mono truncate">{p.name}</span>
                </span>
                {p.github_repo && (
                  <span className="text-[10px] text-muted-foreground/60 font-mono truncate ml-2">{p.github_repo}</span>
                )}
              </button>
            ))}
          </div>
          <div className="border-t border-border p-1">
            <button
              onClick={() => { setOpen(false); onManage?.(); }}
              className="w-full text-left px-3 py-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 cursor-pointer"
            >
              Manage projects…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
