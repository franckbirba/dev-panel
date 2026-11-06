import type { Meta, StoryObj } from "@storybook/react";
import { MergeArtifact } from "@/components/devpanl/artifacts/MergeArtifact";

const meta: Meta<typeof MergeArtifact> = {
  title: "devpanl/artifacts/MergeArtifact",
  component: MergeArtifact,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof MergeArtifact>;

export const WithConflicts: Story = {
  args: {
    artifact: {
      id: "merge-1",
      type: "merge",
      title: "Merge PR #123",
      createdAt: new Date(),
      pr: {
        number: 123,
        title: "feat: add new authentication flow",
        repo: "acme/widget",
        base_branch: "main",
        head_branch: "feat/auth",
        head_sha: "a1b2c3d4e5f67890",
        base_sha: "0987654321fedcba"
      },
      conflicts: [
        {
          path: "src/auth/service.ts",
          hunks: [
            {
              id: "hunk-1",
              ours_range: [42, 45],
              theirs_range: [42, 46],
              ours: [
                "    // Validate token",
                "    if (!isValid(token)) {",
                "      throw new Error('Invalid token');",
                "    }"
              ],
              theirs: [
                "    // Validate and refresh token",
                "    const refreshed = await refreshToken(token);",
                "    if (!refreshed) {",
                "      throw new Error('Token refresh failed');",
                "    }",
                "    token = refreshed;"
              ],
              context_before: [
                "async function authenticate(request: Request) {",
                "  const token = request.headers.get('authorization');",
                "  if (!token) {",
                "    throw new Error('Missing authorization header');",
                "  }"
              ],
              context_after: [
                "  ",
                "  // Proceed with authenticated request",
                "  return handleAuthenticatedRequest(request, token);",
                "}"
              ]
            }
          ]
        }
      ]
    }
  },
};

export const NoConflicts: Story = {
  args: {
    artifact: {
      id: "merge-2",
      type: "merge",
      title: "Merge PR #124",
      createdAt: new Date(),
      pr: {
        number: 124,
        title: "fix: resolve minor UI issues",
        repo: "acme/widget",
        base_branch: "main",
        head_branch: "fix/ui-tweaks",
        head_sha: "f1e2d3c4b5a69780",
        base_sha: "0987654321fedcba"
      },
      conflicts: []
    }
  },
};