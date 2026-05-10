import type { Meta, StoryObj } from "@storybook/react";
import { FleetRowCard } from "@/components/devpanl/FleetRowCard";

const meta: Meta<typeof FleetRowCard> = {
  title: "devpanl/FleetRowCard",
  component: FleetRowCard,
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof FleetRowCard>;

export const Running: Story = {
  args: {
    row: {
      job_id: "j1",
      agent: "builder",
      work_item_short: "ZENO-42",
      state: "running",
      step: "running tests",
      duration_seconds: 124,
      tokens: 38_400,
      spend_usd: 0.18,
    },
  },
};

export const AwaitingApproval: Story = {
  args: {
    row: {
      job_id: "j2",
      agent: "merge-coordinator",
      work_item_short: "DEVPA-190",
      state: "awaiting_approval",
      step: "approving PR #208",
      duration_seconds: 43,
      tokens: 8_200,
      spend_usd: 0.04,
    },
  },
};

export const Blocked: Story = {
  args: {
    row: {
      job_id: "j3",
      agent: "qa",
      work_item_short: "EDMS-17",
      state: "blocked",
      step: "needs design input",
      duration_seconds: 1830,
      tokens: 124_000,
      spend_usd: 0.62,
    },
  },
};

export const Failed: Story = {
  args: {
    row: {
      job_id: "j4",
      agent: "builder",
      work_item_short: "ZENO-339",
      state: "failed",
      step: "exit 1 in npm test",
      duration_seconds: 380,
      tokens: 56_000,
      spend_usd: 0.31,
    },
  },
};

export const Completed: Story = {
  args: {
    row: {
      job_id: "j5",
      agent: "deploy",
      work_item_short: "DEVPA-189",
      state: "completed",
      duration_seconds: 92,
      tokens: 4_100,
      spend_usd: 0.02,
    },
  },
};

export const Queued: Story = {
  args: {
    row: {
      job_id: "j6",
      agent: "reviewer",
      work_item_short: "DEVPA-194",
      state: "queued",
      duration_seconds: 0,
    },
  },
};
