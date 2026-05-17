import { useState } from "react";

interface ConflictHunk {
  id: string;
  file: string;
  ours: string;
  theirs: string;
  resolved: boolean;
  resolution?: "ours" | "theirs" | "ai_proposed";
}

interface MergeArtifactProps {
  artifact: {
    id: string;
    type: "merge";
    title: string;
    meta: string;
    payload: {
      conflictHunks: ConflictHunk[];
      parentContext?: any;
      files: string[];
      branchRange?: { from: string; to: string };
    };
  };
}

export function MergeArtifactView({ artifact }: MergeArtifactProps) {
  const [conflictHunks, setConflictHunks] = useState<ConflictHunk[]>(artifact.payload.conflictHunks);
  
  const handleResolve = (hunkId: string, resolution: "ours" | "theirs" | "ai_proposed") => {
    setConflictHunks(prev => 
      prev.map(hunk => 
        hunk.id === hunkId ? { ...hunk, resolved: true, resolution } : hunk
      )
    );
  };
  
  const handleDispatch = () => {
    // This would open the Dispatch artifact pre-filled with parent context
    console.log("Dispatch to another agent with parent context:", artifact.payload.parentContext);
  };
  
  const allResolved = conflictHunks.every(hunk => hunk.resolved);
  
  return (
    <div className="flex h-full flex-col">
      {/* 3-way diff header */}
      <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-container)] px-4 py-3">
        <div className="flex items-center justify-between">
          <h4 className="text-[13px] font-semibold">Merge Conflict Resolution</h4>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
              {conflictHunks.filter(h => h.resolved).length}/{conflictHunks.length} resolved
            </span>
            {allResolved && (
              <span className="rounded bg-[var(--color-success-soft)] px-2 py-1 font-mono text-[10px] text-[var(--color-success)]">
                RESOLVED
              </span>
            )}
          </div>
        </div>
        
        {/* File list */}
        <div className="mt-2 flex flex-wrap gap-1">
          {artifact.payload.files.map((file, i) => (
            <span 
              key={i}
              className="rounded bg-[var(--color-surface-container-low)] px-2 py-1 font-mono text-[10px] text-[var(--color-foreground-muted)]"
            >
              {file}
            </span>
          ))}
        </div>
      </div>
      
      {/* Conflict hunks */}
      <div className="flex-1 overflow-auto">
        {conflictHunks.map((hunk) => (
          <ConflictHunkView 
            key={hunk.id} 
            hunk={hunk} 
            onResolve={handleResolve} 
          />
        ))}
      </div>
      
      {/* Resolve actions */}
      <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-container)] px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded bg-[var(--color-brand-container)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-brand-container-fg)] hover:opacity-90"
              onClick={handleDispatch}
            >
              ➤ Dispatch to another agent ⌘D
            </button>
          </div>
          
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-container-low)] px-3 py-1.5 text-[12px] text-[var(--color-foreground)] hover:bg-[var(--color-surface-container)]"
              disabled={!allResolved}
            >
              Apply Resolution
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConflictHunkView({ hunk, onResolve }: { 
  hunk: ConflictHunk; 
  onResolve: (hunkId: string, resolution: "ours" | "theirs" | "ai_proposed") => void; 
}) {
  return (
    <div className={`border-b border-[var(--color-border-subtle)] ${hunk.resolved ? "bg-[var(--color-surface-container-low)]" : "bg-[var(--color-background)]"}`}>
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
            {hunk.file}
          </span>
          {hunk.resolved && hunk.resolution && (
            <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] ${
              hunk.resolution === "ours" ? "bg-amber-500/20 text-amber-300" :
              hunk.resolution === "theirs" ? "bg-green-500/20 text-green-300" :
              "bg-blue-500/20 text-blue-300"
            }`}>
              {hunk.resolution.toUpperCase()}
            </span>
          )}
        </div>
        
        {!hunk.resolved && (
          <div className="flex gap-1">
            <button
              type="button"
              className="rounded bg-amber-500/20 px-2 py-1 text-[11px] text-amber-300 hover:bg-amber-500/30"
              onClick={() => onResolve(hunk.id, "ours")}
            >
              Take ours
            </button>
            <button
              type="button"
              className="rounded bg-green-500/20 px-2 py-1 text-[11px] text-green-300 hover:bg-green-500/30"
              onClick={() => onResolve(hunk.id, "theirs")}
            >
              Take theirs
            </button>
            <button
              type="button"
              className="rounded bg-blue-500/20 px-2 py-1 text-[11px] text-blue-300 hover:bg-blue-500/30"
              onClick={() => onResolve(hunk.id, "ai_proposed")}
            >
              AI propose
            </button>
          </div>
        )}
      </div>
      
      {!hunk.resolved && (
        <div className="grid grid-cols-2 gap-4 px-4 pb-4">
          {/* Ours (green) */}
          <div>
            <div className="mb-1 flex items-center gap-2">
              <div className="size-2 rounded-full bg-green-500"></div>
              <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-foreground-faint)]">
                Ours (main)
              </span>
            </div>
            <pre className="max-h-32 overflow-auto rounded bg-[var(--color-surface-container-low)] p-2 font-mono text-[11px]">
              {hunk.ours}
            </pre>
          </div>
          
          {/* Theirs (amber) */}
          <div>
            <div className="mb-1 flex items-center gap-2">
              <div className="size-2 rounded-full bg-amber-500"></div>
              <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-foreground-faint)]">
                Theirs (branch)
              </span>
            </div>
            <pre className="max-h-32 overflow-auto rounded bg-[var(--color-surface-container-low)] p-2 font-mono text-[11px]">
              {hunk.theirs}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
