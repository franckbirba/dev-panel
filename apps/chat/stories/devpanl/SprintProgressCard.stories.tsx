import type { Meta, StoryObj } from "@storybook/react";
import { SprintProgressCard } from "@/components/devpanl/SprintProgressCard";

const meta: Meta<typeof SprintProgressCard> = {
  title: "devpanl/SprintProgressCard",
  component: SprintProgressCard,
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof SprintProgressCard>;

const ITEMS = [
  { sequence_id: 189, project_short: "DEVPA", name: "Scaffold apps/chat", state: "done" },
  { sequence_id: 190, project_short: "DEVPA", name: "Wire SSO + dist build", state: "done" },
  { sequence_id: 191, project_short: "DEVPA", name: "UI library scaffold", state: "done" },
  { sequence_id: 195, project_short: "DEVPA", name: "RuntimeConsoleCard", state: "in_progress" },
  { sequence_id: 204, project_short: "DEVPA", name: "Wire chat → Shelly threads", state: "todo" },
];

export const Early: Story = {
  args: {
    cycle: {
      cycle_name: "v0.42 — Chat is the App",
      start_date: "2026-05-10",
      end_date: "2026-05-10",
      days_remaining: 1,
      total: 21,
      done: 3,
      in_progress: 2,
      backlog: 16,
      blockers: 0,
      work_items: ITEMS.slice(0, 3),
    },
  },
};

export const Mid: Story = {
  args: {
    cycle: {
      cycle_name: "v0.42 — Chat is the App",
      start_date: "2026-05-10",
      end_date: "2026-05-10",
      days_remaining: 1,
      total: 21,
      done: 11,
      in_progress: 4,
      backlog: 6,
      blockers: 0,
      work_items: ITEMS,
    },
  },
};

export const LateWithBlockers: Story = {
  args: {
    cycle: {
      cycle_name: "v0.42 — Chat is the App",
      start_date: "2026-05-10",
      end_date: "2026-05-10",
      days_remaining: 0,
      total: 21,
      done: 16,
      in_progress: 2,
      backlog: 1,
      blockers: 2,
      work_items: ITEMS,
    },
  },
};

export const Done: Story = {
  args: {
    cycle: {
      cycle_name: "v0.42 — Chat is the App",
      start_date: "2026-05-10",
      end_date: "2026-05-10",
      days_remaining: 0,
      total: 21,
      done: 21,
      in_progress: 0,
      backlog: 0,
      blockers: 0,
    },
  },
};
