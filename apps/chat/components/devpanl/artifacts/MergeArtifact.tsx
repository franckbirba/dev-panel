// MergeArtifact.tsx - 3-way diff visualization for merge conflicts
//
// Shows conflicts with hunk-level resolve options and dispatch button.

import { useState } from "react";
import { MergeArtifact as MergeArtifactType } from "@/lib/artifact-registry";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface HunkResolution {
  [hunkId: string]: "ours" | "theirs" | "pending";
}

export function MergeArtifactView({ artifact }: { artifact: MergeArtifactType }) {
  const [resolutions, setResolutions] = useState<HunkResolution>({});
  const [isDispatching, setIsDispatching] = useState(false);

  const handleResolve = (hunkId: string, choice: "ours" | "theirs") => {
    setResolutions(prev => ({
      ...prev,
      [hunkId]: choice
    }));
  };

  const handleDispatch = () => {
    setIsDispatching(true);
    // In a real implementation, this would call the enqueue_job MCP tool
    // For now, we'll simulate the dispatch
    setTimeout(() => {
      setIsDispatching(false);
      // Create a new dispatch artifact with this merge as parent
      // This would normally be handled by the chat backend
    }, 1000);
  };

  const isFullyResolved = artifact.conflicts.every(conflict => 
    conflict.hunks.every(hunk => resolutions[hunk.id] !== undefined)
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-container-low)] px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[14px] font-semibold">Merge Conflict</h2>
            <p className="text-[12px] text-[var(--color-foreground-muted)]">
              {artifact.pr.repo}#{artifact.pr.number} · {artifact.pr.title}
            </p>
          </div>
          <Button 
            onClick={handleDispatch}
            disabled={!isFullyResolved || isDispatching}
            className="h-8 px-3 text-[12px]"
          >
            {isDispatching ? "Dispatching..." : "➤ Dispatch to another agent"}
          </Button>
        </div>
        
        <div className="mt-2 flex gap-4 text-[11px]">
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-green-500" />
            <span>Main ({artifact.pr.base_branch})</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-amber-500" />
            <span>Branch ({artifact.pr.head_branch})</span>
          </div>
        </div>
      </div>

      {/* Conflicts */}
      <div className="flex-1 overflow-auto custom-scrollbar">
        {artifact.conflicts.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="mx-auto h-12 w-12 text-[var(--color-success)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
              <p className="mt-2 text-[12px] text-[var(--color-foreground-muted)]">
                No conflicts detected
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-6 p-4">
            {artifact.conflicts.map((conflict, conflictIndex) => (
              <Card key={`${conflict.path}-${conflictIndex}`} className="overflow-hidden">
                <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-container-low)] px-4 py-2">
                  <h3 className="font-mono text-[11px] font-medium">{conflict.path}</h3>
                </div>
                
                <div className="divide-y divide-[var(--color-border-subtle)]">
                  {conflict.hunks.map((hunk) => {
                    const resolution = resolutions[hunk.id];
                    return (
                      <div key={hunk.id} className="p-4">
                        {/* Context before */}
                        {hunk.context_before.length > 0 && (
                          <pre className="mb-2 rounded bg-[var(--color-surface-container-low)] p-2 text-[11px] text-[var(--color-foreground-faint)]">
                            {hunk.context_before.join("\n")}
                          </pre>
                        )}
                        
                        {/* Conflict hunk */}
                        <div className="relative rounded border border-[var(--color-border-subtle)]">
                          {/* Ours section */}
                          <div className={`border-b border-[var(--color-border-subtle)] ${resolution === "ours" ? "bg-green-500/10" : ""}`}>
                            <div className="flex items-center justify-between bg-green-500/5 px-3 py-1.5">
                              <span className="text-[10px] font-medium text-green-500">OURS</span>
                              {resolution === "ours" && (
                                <span className="text-[10px] text-green-500">Selected</span>
                              )}
                            </div>
                            <pre className="max-h-32 overflow-auto p-3 text-[11px]">
                              {hunk.ours.join("\n")}
                            </pre>
                          </div>
                          
                          {/* Theirs section */}
                          <div className={resolution === "theirs" ? "bg-amber-500/10" : ""}>
                            <div className="flex items-center justify-between bg-amber-500/5 px-3 py-1.5">
                              <span className="text-[10px] font-medium text-amber-500">THEIRS</span>
                              {resolution === "theirs" && (
                                <span className="text-[10px] text-amber-500">Selected</span>
                              )}
                            </div>
                            <pre className="max-h-32 overflow-auto p-3 text-[11px]">
                              {hunk.theirs.join("\n")}
                            </pre>
                          </div>
                          
                          {/* Resolution controls */}
                          <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-container-low)] px-3 py-2">
                            <button
                              onClick={() => handleResolve(hunk.id, "ours")}
                              className={`rounded px-2 py-1 text-[11px] ${
                                resolution === "ours"
                                  ? "bg-green-500 text-white"
                                  : "bg-[var(--color-surface-container)] text-green-500 hover:bg-green-500/20"
                              }`}
                            >
                              Take ours
                            </button>
                            <button
                              onClick={() => handleResolve(hunk.id, "theirs")}
                              className={`rounded px-2 py-1 text-[11px] ${
                                resolution === "theirs"
                                  ? "bg-amber-500 text-white"
                                  : "bg-[var(--color-surface-container)] text-amber-500 hover:bg-amber-500/20"
                              }`}
                            >
                              Take theirs
                            </button>
                            <button className="rounded bg-[var(--color-surface-container)] px-2 py-1 text-[11px] text-[var(--color-foreground)] hover:bg-[var(--color-brand-soft)]">
                              AI propose
                            </button>
                          </div>
                        </div>
                        
                        {/* Context after */}
                        {hunk.context_after.length > 0 && (
                          <pre className="mt-2 rounded bg-[var(--color-surface-container-low)] p-2 text-[11px] text-[var(--color-foreground-faint)]">
                            {hunk.context_after.join("\n")}
                          </pre>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}