import { useState } from "react";
import { X, Minimize2, Maximize2 } from "lucide-react";
import { useArtifacts, useActiveArtifact } from "@/lib/artifact-registry";
import { MergeArtifactView } from "./artifacts/MergeArtifact";
import { DispatchArtifactView } from "./artifacts/DispatchArtifact";
import { LogStreamArtifactView } from "./artifacts/LogStreamArtifact";

type Tab = {
  id: string;
  label: string;
  meta: string;
  type: string;
  hasAttention: boolean;
};

export function CanvasDock() {
  const artifacts = useArtifacts();
  const activeArtifact = useActiveArtifact();
  
  // For now, we'll use the first artifact as active if none is set
  const activeTabId = activeArtifact?.id || artifacts[0]?.id || null;
  
  const tabs: Tab[] = artifacts.map(artifact => ({
    id: artifact.id,
    label: artifact.title,
    meta: artifact.meta,
    type: artifact.type,
    hasAttention: artifact.type === "stream" || (artifact as any).hasAttention || false, // Streams always have attention
  }));
  
  const [isExpanded, setIsExpanded] = useState(true);
  
  if (artifacts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center border-l border-[var(--color-border-subtle)] bg-[var(--color-background)]">
        <p className="text-[11px] text-[var(--color-foreground-faint)]">
          No artifacts
        </p>
      </div>
    );
  }
  
  return (
    <div className={`flex h-full flex-col border-l border-[var(--color-border-subtle)] bg-[var(--color-background)] ${isExpanded ? "w-96" : "w-80"}`}>
      {/* Header with controls */}
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-container)] px-3 py-2">
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-[var(--color-foreground-faint)]">
          Artifacts
        </h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="rounded p-1 text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-container)] hover:text-[var(--color-foreground)]"
          >
            {isExpanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
          <button
            type="button"
            className="rounded p-1 text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-container)] hover:text-[var(--color-foreground)]"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Tab Strip */}
      <div className="flex border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-container)]">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {}}
              className={`flex flex-1 items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors ${
                isActive
                  ? "bg-[var(--color-brand-soft)] text-[var(--color-brand)]"
                  : "text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-container-low)]"
              }`}
            >
              <div className={`size-2 rounded-full ${
                tab.type === "merge" ? "bg-amber-400" :
                tab.type === "dispatch" ? "bg-green-400" :
                "bg-blue-400"
              }`} />
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{tab.label}</span>
                  {tab.hasAttention && (
                    <div className="size-1.5 rounded-full bg-red-500" />
                  )}
                </div>
                <span className="font-mono text-[10px] text-[var(--color-foreground-faint)]">
                  {tab.meta}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Artifact Content */}
      <div className="flex-1 overflow-auto">
        {activeArtifact?.type === "merge" && (
          <MergeArtifactView artifact={activeArtifact} />
        )}
        {activeArtifact?.type === "dispatch" && (
          <DispatchArtifactView artifact={activeArtifact} />
        )}
        {activeArtifact?.type === "stream" && (
          <LogStreamArtifactView artifact={activeArtifact} />
        )}
      </div>

      {/* Keyboard hint footer */}
      <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-container)] px-3 py-2">
        <div className="flex items-center justify-between text-[10px] text-[var(--color-foreground-faint)]">
          <div className="flex items-center gap-2">
            <kbd className="hotkey">⌘[</kbd>
            <span>Previous</span>
          </div>
          <div className="flex items-center gap-2">
            <span>Next</span>
            <kbd className="hotkey">⌘]</kbd>
          </div>
          <div className="flex items-center gap-2">
            <span>Promote</span>
            <kbd className="hotkey">⌘↵</kbd>
          </div>
        </div>
      </div>
    </div>
  );
}
