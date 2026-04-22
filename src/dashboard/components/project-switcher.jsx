import { useState, useRef, useEffect } from "react";
import { listLocalProjects, getCurrentProject, setCurrentProject } from "@/lib/projects-store";

function ProjectAvatar({ name, isCurrent }) {
  const initials = (name || '?').slice(0, 2).toUpperCase();
  return (
    <span className={`w-6 h-6 rounded-md flex items-center justify-center text-[9px] font-bold font-mono shrink-0 ${
      isCurrent ? 'bg-brand/20 text-brand' : 'bg-white/[0.04] text-muted-foreground'
    }`}>
      {initials}
    </span>
  );
}

export function ProjectSwitcher({ onSwitch, onManage, collapsed }) {
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
        className={`flex items-center gap-2.5 w-full text-xs rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/[0.03] cursor-pointer transition-all ${
          collapsed ? 'justify-center p-2' : 'px-3 py-2'
        }`}
        title={collapsed ? current.name : 'Switch project'}
      >
        <ProjectAvatar name={current.name} isCurrent />
        {!collapsed && (
          <>
            <span className="font-mono truncate flex-1 text-left">{current.name}</span>
            <svg viewBox="0 0 12 12" className="w-3 h-3 opacity-40">
              <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.2" fill="none" />
            </svg>
          </>
        )}
      </button>

      {open && (
        <div className="absolute left-0 md:left-auto md:right-0 bottom-full mb-1 w-72 rounded-xl glass-card shadow-2xl z-50 animate-scale-in overflow-hidden">
          <div className="p-1.5">
            {projects.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-muted-foreground">No projects yet</div>
            )}
            {projects.map(p => (
              <button
                key={p.id}
                onClick={() => pick(p.id)}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-xs cursor-pointer flex items-center gap-2.5 transition-all ${
                  p.id === current.id
                    ? "bg-brand/10 text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/[0.03]"
                }`}
              >
                <ProjectAvatar name={p.name} isCurrent={p.id === current.id} />
                <span className="font-mono truncate">{p.name}</span>
                {p.github_repo && (
                  <span className="text-[10px] text-muted-foreground/40 font-mono truncate ml-auto">{p.github_repo}</span>
                )}
              </button>
            ))}
          </div>
          <div className="border-t border-border p-1.5">
            <button
              onClick={() => { setOpen(false); onManage?.(); }}
              className="w-full text-left px-3 py-2 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-white/[0.03] cursor-pointer transition-colors"
            >
              Manage projects…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
