import type { Meta, StoryObj } from "@storybook/react";
import { WorkItemCard } from "@/components/devpanl/WorkItemCard";

const meta: Meta<typeof WorkItemCard> = {
  title: "devpanl/WorkItemCard",
  component: WorkItemCard,
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof WorkItemCard>;

export const Backlog: Story = {
  args: {
    item: {
      sequence_id: 209,
      project_short: "DEVPA",
      name: "Update CLAUDE.md + memory: chat-is-primary",
      state: "backlog",
      priority: "low",
      description: "Document the chat-first architecture so future agents…",
    },
  },
};

export const InProgress: Story = {
  args: {
    item: {
      sequence_id: 195,
      project_short: "DEVPA",
      name: "Card: RuntimeConsoleCard (tail_log streaming) + story",
      state: "in_progress",
      priority: "high",
      assignee: { name: "Franck", initials: "FB" },
      cycle_progress: { done: 8, total: 21 },
      description: "Streaming card consuming SSE from the new tail_log MCP tool",
    },
  },
};

export const Urgent: Story = {
  args: {
    item: {
      sequence_id: 190,
      project_short: "DEVPA",
      name: "Wire SSO + dist build pipeline + replace /dashboard",
      state: "review",
      priority: "urgent",
      assignee: { name: "Franck", initials: "FB" },
      cycle_progress: { done: 18, total: 21 },
    },
  },
};

export const Done: Story = {
  args: {
    item: {
      sequence_id: 189,
      project_short: "DEVPA",
      name: "Scaffold apps/chat — Qwen3 + devpanl-mcp",
      state: "done",
      priority: "urgent",
      assignee: { name: "Franck", initials: "FB" },
    },
  },
};
