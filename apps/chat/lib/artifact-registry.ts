// Artifact registry — in-memory store for active artifacts in the cockpit
//
// Manages typed artifacts (Merge, Dispatch, LogStream, etc) with lifecycle:
//   - register(artifact) — add to the registry
//   - setActive(id) — focus the dock on this artifact
//   - useArtifacts() — React hook to subscribe to the active set
//   - getParentContext(id) — retrieve parent context for Dispatch inheritance

import { useState, useEffect } from "react";

export type ArtifactType = "merge" | "dispatch" | "log-stream";

export interface BaseArtifact {
  id: string;
  type: ArtifactType;
  title: string;
  createdAt: Date;
  parentId?: string;
}

export interface MergeArtifact extends BaseArtifact {
  type: "merge";
  pr: {
    number: number;
    title: string;
    repo: string;
    base_branch: string;
    head_branch: string;
    head_sha: string;
    base_sha: string;
  };
  conflicts: Array<{
    path: string;
    hunks: Array<{
      id: string;
      ours_range: [number, number];
      theirs_range: [number, number];
      ours: string[];
      theirs: string[];
      context_before: string[];
      context_after: string[];
    }>;
  }>;
}

export interface DispatchArtifact extends BaseArtifact {
  type: "dispatch";
  parent?: {
    type: "merge-coord:fail";
    pr_number: number;
    files: string[];
    conflict_diff?: string;
  };
  role: string;
  scope: {
    files: string[];
    branch_range?: [string, string];
    inherit_from_parent?: boolean;
  };
  directive: string;
}

export interface LogStreamArtifact extends BaseArtifact {
  type: "log-stream";
  jobId: string;
}

export type Artifact = MergeArtifact | DispatchArtifact | LogStreamArtifact;

class ArtifactRegistry {
  private artifacts: Map<string, Artifact> = new Map();
  private listeners: Set<(artifacts: Artifact[]) => void> = new Set();
  private activeId: string | null = null;

  register(artifact: Artifact): void {
    this.artifacts.set(artifact.id, artifact);
    this.notifyListeners();
  }

  unregister(id: string): void {
    this.artifacts.delete(id);
    if (this.activeId === id) {
      this.activeId = null;
    }
    this.notifyListeners();
  }

  setActive(id: string): void {
    if (this.artifacts.has(id)) {
      this.activeId = id;
      this.notifyListeners();
    }
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  getArtifact(id: string): Artifact | undefined {
    return this.artifacts.get(id);
  }

  getParentContext(id: string): Artifact | undefined {
    const artifact = this.artifacts.get(id);
    if (!artifact || !artifact.parentId) return undefined;
    return this.artifacts.get(artifact.parentId);
  }

  getAll(): Artifact[] {
    return Array.from(this.artifacts.values());
  }

  subscribe(listener: (artifacts: Artifact[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.getAll());
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    const artifacts = this.getAll();
    this.listeners.forEach((listener) => listener(artifacts));
  }
}

// Singleton instance
export const artifactRegistry = new ArtifactRegistry();

// React hook for consuming artifacts
export function useArtifacts(): {
  artifacts: Artifact[];
  activeId: string | null;
  setActive: (id: string) => void;
} {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    return artifactRegistry.subscribe((newArtifacts) => {
      setArtifacts(newArtifacts);
      setActiveId(artifactRegistry.getActiveId());
    });
  }, []);

  const setActive = (id: string) => {
    artifactRegistry.setActive(id);
  };

  return { artifacts, activeId, setActive };
}