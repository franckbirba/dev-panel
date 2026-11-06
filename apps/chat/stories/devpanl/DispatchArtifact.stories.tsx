import type { Meta, StoryObj } from "@storybook/react";
import { DispatchArtifact } from "@/components/devpanl/artifacts/DispatchArtifact";

const meta: Meta<typeof DispatchArtifact> = {
  title: "devpanl/artifacts/DispatchArtifact",
  component: DispatchArtifact,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof DispatchArtifact>;

export const FromMergeConflict: Story = {
  args: {
    artifact: {
      id: "dispatch-1",
      type: "dispatch",
      title: "Dispatch: Resolve merge conflict",
      createdAt: new Date(),
      parent: {
        type: "merge-coord:fail",
        pr_number: 123,
        files: ["src/auth/service.ts", "src/auth/types.ts"],
        conflict_diff: "<<<<<<< ours\n  if (!isValid(token)) {\n=======\n  const refreshed = await refreshToken(token);\n  if (!refreshed) {\n>>>>>>> theirs"
      },
      role: "builder",
      scope: {
        files: ["src/auth/service.ts", "src/auth/types.ts"],
        inherit_from_parent: true
      },
      directive: "Resolve the merge conflict in src/auth/service.ts by taking the approach that maintains both token validation and refresh capabilities. Ensure the solution handles edge cases where refresh might fail."
    }
  },
};

export const Standalone: Story = {
  args: {
    artifact: {
      id: "dispatch-2",
      type: "dispatch",
      title: "Dispatch: Implement feature",
      createdAt: new Date(),
      role: "builder",
      scope: {
        files: ["src/components/NewFeature.tsx"],
        branch_range: ["main", "feat/new-feature"]
      },
      directive: "Implement the new feature according to the specification document. Focus on maintainability and performance."
    }
  },
};