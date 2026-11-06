// CanvasDock.tsx - Right-side dock for cockpit artifacts
//
// Tabbed interface for viewing artifacts with keyboard navigation.

import { useState, useEffect } from "react";
import { useArtifacts } from "@/lib/artifact-registry";
import { MergeArtifactView } from "./artifacts/MergeArtifact";
import { DispatchArtifactView } from "./artifacts/DispatchArtifact";
import { LogStreamArtifactView } from "./artifacts/LogStreamArtifact";

interface Tab {
  id: string;
  title: string;
  type: string;
  meta?: string;
  hasAttention?: boolean;
}

export function CanvasDock() {
  const { artifacts, activeId, setActive } = useArtifacts();
  const [expanded, setExpanded] = useState(false);
  
  // Get tabs from artifacts
  const tabs: Tab[] = artifacts.map((artifact) => {
    let title = artifact.title;
    let meta = "";
    let hasAttention = false;
    
    switch (artifact.type) {
      case "merge":
        meta = `PR#${artifact.pr.number}`;
        break;
      case "dispatch":
        meta = `${artifact.role}`;
        break;
      case "log-stream":
        meta = "live";
        hasAttention = true; // Streams always have attention
        break;
    }
    
    return {
      id: artifact.id,
      title,
      type: artifact.type,
      meta,
      hasAttention,
    };
  });

  const activeArtifact = artifacts.find(a => a.id === activeId);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        // Switch tabs with Cmd+[ and Cmd+]
        if (e.key === "[" && tabs.length > 0) {
          e.preventDefault();
          const currentIndex = tabs.findIndex(t => t.id === activeId);
          const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length;
          setActive(tabs[prevIndex].id);
        } else if (e.key === "]" && tabs.length > 0) {
          e.preventDefault();
          const currentIndex = tabs.findIndex(t => t.id === activeId);
          const nextIndex = (currentIndex + 1) % tabs.length;
          setActive(tabs[nextIndex].id);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeId, tabs, setActive]);

  if (tabs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center border-l border-[var(--color-border-subtle)] bg-[var(--color-surface-container-lowest)]">
        <p className="text-[11px] text-[var(--color-foreground-faint)]">
          No active artifacts
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col border-l border-[var(--color-border-subtle)] bg-[var(--color-surface-container-lowest)]">
      {/* Tab strip */}
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-2 py-1">
        <div className="flex items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => {
            const isActive = tab.id === activeId;
            return (
              <button
                key={tab.id}
                onClick={() => setActive(tab.id)}
                className={`flex items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-all ${
                  isActive
                    ? "bg-[var(--color-brand-soft)] text-[var(--color-brand)]"
                    : "text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-container-low)] hover:text-[var(--color-foreground)]"
                }`}
              >
                {tab.hasAttention && (
                  <div className="h-1.5 w-1.5 rounded-full bg-[var(--color-error)]" />
                )}
                <span className="truncate">{tab.title}</span>
                {tab.meta && (
                  <span className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-container)] px-1 py-0.5 text-[9px]">
                    {tab.meta}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        
        <div className="flex items-center gap-1">
          <button
            onClick={() => setExpanded(!expanded)}
            className="rounded p-1 text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-container-low)] hover:text-[var(--color-foreground)]"
          >
            {expanded ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M9 3v18" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M3 9h18" />
              </svg>
            )}
          </button>
          
          <button className="rounded p-1 text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-container-low)] hover:text-[var(--color-foreground)]">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <line x1="12" y1="5" x2="12" y2="19" />
            </svg>
          </button>
        </div>
      </div>

      {/* Artifact content */}
      <div className="flex-1 overflow-hidden">
        {activeArtifact ? (
          <div className="h-full">
            {activeArtifact.type === "merge" && (
              <MergeArtifactView artifact={activeArtifact} />
            )}
            {activeArtifact.type === "dispatch" && (
              <DispatchArtifactView artifact={activeArtifact} />
            )}
            {activeArtifact.type === "log-stream" && (
              <LogStreamArtifactView artifact={activeArtifact} />
            )}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-[11px] text-[var(--color-foreground-faint)]">
              Select an artifact to view
            </p>
          </div>
        )}
      </div>

      {/* Keyboard hint footer */}
      <div className="border-t border-[var(--color-border-subtle)] px-3 py-1.5">
        <div className="flex items-center justify-between text-[9px] text-[var(--color-foreground-faint)]">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1">
              <kbd className="hotkey">⌘[</kbd>
              <span>Prev</span>
            </span>
            <span className="flex items-center gap-1">
              <kbd className="hotkey">⌘]</kbd>
              <span>Next</span>
            </span>
          </div>
          <div className="flex items-center gap-1">
            <kbd className="hotkey">⌘↵</kbd>
            <span>Promote</span>
          </div>
        </div>
      </div>
    </div>
  );
}