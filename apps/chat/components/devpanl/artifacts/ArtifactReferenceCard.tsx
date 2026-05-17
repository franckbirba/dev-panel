import { useState } from "react";
import { useSetActiveArtifact } from "@/lib/artifact-registry";

interface ArtifactReferenceCardProps {
  artifact: {
    id: string;
    type: "artifact-reference";
    title: string;
    meta: string;
    payload: {
      artifactId: string;
      hasAttention: boolean;
    };
  };
}

export function ArtifactReferenceCard({ artifact }: ArtifactReferenceCardProps) {
  const setActiveArtifact = useSetActiveArtifact();
  const [isHovered, setIsHovered] = useState(false);
  
  const handleClick = () => {
    // Set the referenced artifact as active in the dock
    setActiveArtifact(artifact.payload.artifactId);
  };
  
  return (
    <div 
      className={`inline-flex items-center gap-2 rounded border px-2.5 py-1.5 text-[11px] transition-all ${
        isHovered 
          ? "border-[var(--color-brand-border)] bg-[var(--color-brand-soft)]" 
          : "border-[var(--color-border-subtle)] bg-[var(--color-surface-container-low)]"
      }`}
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="flex size-2 items-center justify-center">
        <div className="size-1.5 rounded-full bg-[var(--color-brand)]" />
      </div>
      <span className="font-medium">{artifact.title}</span>
      <span className="font-mono text-[var(--color-foreground-faint)]">
        {artifact.meta}
      </span>
      {artifact.payload.hasAttention && (
        <div className="relative flex size-2 items-center justify-center">
          <div className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-60 animate-ping" />
          <div className="relative size-1.5 rounded-full bg-red-500" />
        </div>
      )}
      <button
        type="button"
        className="rounded bg-[var(--color-brand-container)] px-1.5 py-0.5 text-[9px] text-[var(--color-brand-container-fg)] hover:opacity-90"
        onClick={(e) => {
          e.stopPropagation();
          handleClick();
        }}
      >
        Open
      </button>
    </div>
  );
}
