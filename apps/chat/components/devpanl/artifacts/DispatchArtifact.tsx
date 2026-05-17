import { useState } from "react";

interface Role {
  id: string;
  name: string;
  description: string;
  tint: string;
  load: { 
    cpu: number; 
    memory: number;
  };
  verdict: "best_fit" | "caution";
}

interface DispatchArtifactProps {
  artifact: {
    id: string;
    type: "dispatch";
    title: string;
    meta: string;
    payload: {
      parentContext?: any;
      roles: Role[];
      files: string[];
      branchRange?: { from: string; to: string };
      directive: string;
    };
  };
}

export function DispatchArtifactView({ artifact }: DispatchArtifactProps) {
  const [selectedRole, setSelectedRole] = useState<string>(artifact.payload.roles[0]?.id || "");
  const [directive, setDirective] = useState<string>(artifact.payload.directive);
  
  const handleDispatch = () => {
    // This would enqueue a real builder job via the existing MCP path
    console.log("Dispatching job with role:", selectedRole, "directive:", directive);
  };
  
  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-container)] px-4 py-3">
        <h4 className="text-[13px] font-semibold">Dispatch Job</h4>
        <p className="mt-1 text-[11px] text-[var(--color-foreground-muted)]">
          Assign task to an agent and provide execution context
        </p>
      </div>
      
      <div className="flex-1 overflow-auto">
        {/* Role picker */}
        <div className="border-b border-[var(--color-border-subtle)] px-4 py-3">
          <h5 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-[var(--color-foreground-faint)]">
            Agent Role
          </h5>
          
          <div className="grid grid-cols-1 gap-2">
            {artifact.payload.roles.map((role) => {
              const isSelected = role.id === selectedRole;
              
              return (
                <div 
                  key={role.id}
                  className={`rounded border p-3 transition-colors ${isSelected ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)]" : "border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-container-low)]"}`}
                  onClick={() => setSelectedRole(role.id)}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <div 
                          className="size-3 rounded-full"
                          style={{ backgroundColor: role.tint }}
                        />
                        <span className="font-medium">{role.name}</span>
                        {role.verdict === "caution" && (
                          <span className="rounded bg-[var(--color-warning-soft)] px-1.5 py-0.5 text-[9px] text-[var(--color-warning)]">
                            CAUTION
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] text-[var(--color-foreground-muted)]">
                        {role.description}
                      </p>
                    </div>
                    
                    <div className="flex flex-col items-end">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-[var(--color-foreground-faint)]">
                          CPU: {role.load.cpu}%
                        </span>
                        <span className="font-mono text-[10px] text-[var(--color-foreground-faint)]">
                          MEM: {role.load.memory}%
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        
        {/* Scope */}
        <div className="border-b border-[var(--color-border-subtle)] px-4 py-3">
          <h5 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-[var(--color-foreground-faint)]">
            Scope
          </h5>
          
          <div className="flex flex-wrap gap-1">
            {artifact.payload.files.map((file, i) => (
              <span 
                key={i}
                className="rounded bg-[var(--color-surface-container-low)] px-2 py-1 font-mono text-[10px] text-[var(--color-foreground-muted)]"
              >
                {file}
              </span>
            ))}
          </div>
          
          {artifact.payload.branchRange && (
            <div className="mt-2 flex gap-2">
              <span className="rounded bg-[var(--color-surface-container-low)] px-2 py-1 font-mono text-[10px] text-[var(--color-foreground-muted)]">
                {artifact.payload.branchRange.from}
              </span>
              <span className="font-mono text-[10px] text-[var(--color-foreground-faint)]">→</span>
              <span className="rounded bg-[var(--color-surface-container-low)] px-2 py-1 font-mono text-[10px] text-[var(--color-foreground-muted)]">
                {artifact.payload.branchRange.to}
              </span>
            </div>
          )}
        </div>
        
        {/* Directive box */}
        <div className="px-4 py-3">
          <h5 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-[var(--color-foreground-faint)]">
            Directive
          </h5>
          
          <textarea
            value={directive}
            onChange={(e) => setDirective(e.target.value)}
            className="min-h-[120px] w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-background)] px-3 py-2 font-mono text-[11px] text-[var(--color-foreground)] focus:border-[var(--color-brand)] focus:outline-none"
            placeholder="Enter task directive..."
          />
        </div>
      </div>
      
      {/* Footer */}
      <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-container)] px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex gap-4 text-[11px] text-[var(--color-foreground-faint)]">
            <span>ETA: 2m</span>
            <span>Est. tokens: 1.2k</span>
            <span>Scope: 5 files</span>
          </div>
          
          <button
            type="button"
            className="rounded bg-[var(--color-brand-container)] px-4 py-2 text-[12px] font-medium text-[var(--color-brand-container-fg)] hover:opacity-90"
            onClick={handleDispatch}
          >
            Dispatch ⌘↵
          </button>
        </div>
      </div>
    </div>
  );
}
