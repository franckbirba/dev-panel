// DispatchArtifact.tsx - Job composer with role/scoped context
//
// Allows composing jobs with role selection, scope definition, and directive drafting.

import { useState } from "react";
import { DispatchArtifact as DispatchArtifactType } from "@/lib/artifact-registry";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

interface RoleOption {
  id: string;
  name: string;
  description: string;
  colorClass: string;
  bgColorClass: string;
  verdict: "best_fit" | "caution";
}

const ROLE_OPTIONS: RoleOption[] = [
  {
    id: "builder",
    name: "Builder",
    description: "Code implementation specialist",
    colorClass: "text-[var(--color-agent-devpa)]",
    bgColorClass: "bg-[var(--color-agent-devpa-soft)]",
    verdict: "best_fit"
  },
  {
    id: "reviewer",
    name: "Reviewer",
    description: "Code quality assurance",
    colorClass: "text-[var(--color-agent-task)]",
    bgColorClass: "bg-[var(--color-agent-task-soft)]",
    verdict: "best_fit"
  },
  {
    id: "qa",
    name: "QA Engineer",
    description: "Testing and validation specialist",
    colorClass: "text-[var(--color-agent-edms)]",
    bgColorClass: "bg-[var(--color-agent-edms-soft)]",
    verdict: "best_fit"
  },
  {
    id: "pm",
    name: "Product Manager",
    description: "Strategic planning and coordination",
    colorClass: "text-[var(--color-agent-zeno)]",
    bgColorClass: "bg-[var(--color-agent-zeno-soft)]",
    verdict: "caution"
  },
  {
    id: "designer",
    name: "Designer",
    description: "UI/UX specialist",
    colorClass: "text-[var(--color-brand)]",
    bgColorClass: "bg-[var(--color-brand-soft)]",
    verdict: "caution"
  }
];

interface ScopeChip {
  id: string;
  label: string;
  type: "file" | "branch" | "inherit";
}

export function DispatchArtifactView({ artifact }: { artifact: DispatchArtifactType }) {
  const [selectedRole, setSelectedRole] = useState<string>(ROLE_OPTIONS[0].id);
  const [directive, setDirective] = useState<string>(artifact.directive || "");
  const [isDispatching, setIsDispatching] = useState(false);

  // Generate scope chips based on parent context or defaults
  const scopeChips: ScopeChip[] = [];
  
  if (artifact.parent) {
    // Add file chips from parent context
    artifact.parent.files.forEach((file, index) => {
      scopeChips.push({
        id: `file-${index}`,
        label: file,
        type: "file"
      });
    });
    
    // Add inherit chip for conflict diff if available
    if (artifact.parent.conflict_diff) {
      scopeChips.push({
        id: "inherit-conflict",
        label: "Conflict diff",
        type: "inherit"
      });
    }
    
    // Add inherit chip for branch range
    scopeChips.push({
      id: "inherit-branch",
      label: `${artifact.parent.pr_number ? `PR#${artifact.parent.pr_number}` : "Branch range"}`,
      type: "inherit"
    });
  } else {
    // Default scope chips
    scopeChips.push({
      id: "inherit-thread",
      label: "Inherit from thread",
      type: "inherit"
    });
  }

  const selectedRoleData = ROLE_OPTIONS.find(r => r.id === selectedRole);

  const handleDispatch = () => {
    setIsDispatching(true);
    // In a real implementation, this would call the enqueue_job MCP tool
    // For now, we'll simulate the dispatch
    setTimeout(() => {
      setIsDispatching(false);
      // Create a new log stream artifact for the dispatched job
      // This would normally be handled by the chat backend
    }, 1000);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-container-low)] px-4 py-3">
        <h2 className="text-[14px] font-semibold">Dispatch Job</h2>
        <p className="text-[12px] text-[var(--color-foreground-muted)]">
          Assign work to an agent with specific context
        </p>
      </div>

      <div className="flex-1 overflow-auto custom-scrollbar">
        <div className="space-y-6 p-4">
          {/* Role Selection */}
          <Card className="p-4">
            <Label className="mb-3 block text-[12px] font-medium">
              Role
            </Label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {ROLE_OPTIONS.map((role) => (
                <button
                  key={role.id}
                  onClick={() => setSelectedRole(role.id)}
                  className={`flex items-start rounded border p-3 text-left transition-all ${
                    selectedRole === role.id
                      ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)]"
                      : "border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-container-low)]"
                  }`}
                >
                  <div 
                    className={`mr-3 mt-0.5 h-3 w-3 rounded-full ${role.bgColorClass.replace("soft", "")}`}
                  />
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-medium">{role.name}</span>
                      <span 
                        className={`text-[9px] px-1.5 py-0.5 rounded ${
                          role.verdict === "best_fit"
                            ? "bg-green-500/20 text-green-500"
                            : "bg-amber-500/20 text-amber-500"
                        }`}
                      >
                        {role.verdict === "best_fit" ? "Best fit" : "Caution"}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-[var(--color-foreground-muted)]">
                      {role.description}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </Card>

          {/* Scope */}
          <Card className="p-4">
            <Label className="mb-3 block text-[12px] font-medium">
              Scope
            </Label>
            <div className="flex flex-wrap gap-2">
              {scopeChips.map((chip) => (
                <span
                  key={chip.id}
                  className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] ${
                    chip.type === "file"
                      ? "bg-blue-500/10 text-blue-500"
                      : chip.type === "branch"
                      ? "bg-purple-500/10 text-purple-500"
                      : "bg-[var(--color-brand-soft)] text-[var(--color-brand)]"
                  }`}
                >
                  {chip.label}
                </span>
              ))}
            </div>
          </Card>

          {/* Directive */}
          <Card className="p-4">
            <Label className="mb-3 block text-[12px] font-medium">
              Directive
            </Label>
            <Textarea
              value={directive}
              onChange={(e) => setDirective(e.target.value)}
              placeholder="Describe what you want the agent to do..."
              className="min-h-[120px] text-[12px]"
            />
          </Card>
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-container-low)] px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="text-[11px] text-[var(--color-foreground-faint)]">
            <span>ETA: 2-5 min</span>
            <span className="mx-2">•</span>
            <span>Tokens: ~1.2k</span>
          </div>
          <Button 
            onClick={handleDispatch}
            disabled={isDispatching}
            className="h-8 px-4 text-[12px]"
          >
            {isDispatching ? "Dispatching..." : "Dispatch"}
          </Button>
        </div>
      </div>
    </div>
  );
}