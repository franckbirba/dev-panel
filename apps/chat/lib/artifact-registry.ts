import { useCallback, useEffect, useState } from "react";

export type ArtifactType = "merge" | "dispatch" | "stream";

export interface BaseArtifact {
  id: string;
  type: ArtifactType;
  title: string;
  meta: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MergeArtifact extends BaseArtifact {
  type: "merge";
  payload: {
    conflictHunks: Array<{
      id: string;
      file: string;
      ours: string;
      theirs: string;
      resolved: boolean;
      resolution?: "ours" | "theirs" | "ai_proposed";
    }>;
    parentContext?: any;
    files: string[];
    branchRange?: { from: string; to: string };
  };
}

export interface DispatchArtifact extends BaseArtifact {
  type: "dispatch";
  payload: {
    parentContext?: any;
    roles: Array<{
      id: string;
      name: string;
      description: string;
      tint: string;
      load: { 
        cpu: number; 
        memory: number;
      };
      verdict: "best_fit" | "caution";
    }>;
    files: string[];
    branchRange?: { from: string; to: string };
    directive: string;
  };
}

export interface StreamArtifact extends BaseArtifact {
  type: "stream";
  payload: {
    jobId: string;
  };
}

export type Artifact = MergeArtifact | DispatchArtifact | StreamArtifact;

class ArtifactRegistry {
  private artifacts: Map<string, Artifact> = new Map();
  private activeId: string | null = null;
  private listeners: Array<() => void> = [];

  register(artifact: Artifact): void {
    this.artifacts.set(artifact.id, artifact);
    this.notifyListeners();
  }

  unregister(id: string): void {
    this.artifacts.delete(id);
    if (this.activeId === id) {
      this.activeId = null;
      this.notifyListeners();
    }
  }

  get(id: string): Artifact | undefined {
    return this.artifacts.get(id);
  }

  getAll(): Artifact[] {
    return Array.from(this.artifacts.values());
  }

  getActive(): Artifact | undefined {
    return this.activeId ? this.artifacts.get(this.activeId) : undefined;
  }

  setActive(id: string | null): void {
    this.activeId = id;
    this.notifyListeners();
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }
}

const artifactRegistry = new ArtifactRegistry();

export function useArtifacts(): Artifact[] {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  useEffect(() => {
    setArtifacts(artifactRegistry.getAll());
    return artifactRegistry.subscribe(() => {
      setArtifacts(artifactRegistry.getAll());
    });
  }, []);

  return artifacts;
}

export function useActiveArtifact(): Artifact | undefined {
  const [activeArtifact, setActiveArtifact] = useState<Artifact | undefined>(
    artifactRegistry.getActive()
  );

  useEffect(() => {
    setActiveArtifact(artifactRegistry.getActive());
    return artifactRegistry.subscribe(() => {
      setActiveArtifact(artifactRegistry.getActive());
    });
  }, []);

  return activeArtifact;
}

export const useSetActiveArtifact = () => {
  return useCallback((id: string | null) => {
    artifactRegistry.setActive(id);
  }, []);
};

export const useUnregisterArtifact = () => {
  return useCallback((id: string) => {
    artifactRegistry.unregister(id);
  }, []);
};
