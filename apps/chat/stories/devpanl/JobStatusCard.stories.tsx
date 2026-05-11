import type { Meta, StoryObj } from "@storybook/react";
import { JobStatusCard } from "@/components/devpanl/JobStatusCard";
import { JOB_STATUS_EXAMPLE } from "@/lib/chat-renderer-examples";

const meta: Meta<typeof JobStatusCard> = {
  title: "devpanl/JobStatusCard",
  component: JobStatusCard,
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof JobStatusCard>;

export const Running: Story = {
  args: { job: JOB_STATUS_EXAMPLE },
};

export const Queued: Story = {
  args: {
    job: {
      ...JOB_STATUS_EXAMPLE,
      state: "queued",
      progress: undefined,
      detail: "Waiting for ENV injection",
    },
  },
};

export const Success: Story = {
  args: {
    job: { ...JOB_STATUS_EXAMPLE, state: "success", progress: 100 },
  },
};

export const Failed: Story = {
  args: {
    job: {
      ...JOB_STATUS_EXAMPLE,
      state: "failed",
      progress: undefined,
      detail: "exit 1 — see console-stream above",
    },
  },
};
