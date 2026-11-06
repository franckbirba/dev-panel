import type { Meta, StoryObj } from "@storybook/react";
import { LogStreamArtifact } from "@/components/devpanl/artifacts/LogStreamArtifact";

const meta: Meta<typeof LogStreamArtifact> = {
  title: "devpanl/artifacts/LogStreamArtifact",
  component: LogStreamArtifact,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof LogStreamArtifact>;

export const Streaming: Story = {
  args: {
    artifact: {
      id: "log-stream-1",
      type: "log-stream",
      title: "Build Process Logs",
      createdAt: new Date(),
      jobId: "job-abc123"
    }
  },
};

export const Disconnected: Story = {
  args: {
    artifact: {
      id: "log-stream-2",
      type: "log-stream",
      title: "Test Runner Logs",
      createdAt: new Date(),
      jobId: "job-def456"
    }
  },
};