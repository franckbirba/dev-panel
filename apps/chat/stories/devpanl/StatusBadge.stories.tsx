import type { Meta, StoryObj } from "@storybook/react";
import { StatusBadge } from "@/components/devpanl/StatusBadge";

const meta: Meta<typeof StatusBadge> = {
  title: "devpanl/StatusBadge",
  component: StatusBadge,
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof StatusBadge>;

export const Backlog: Story = { args: { status: "backlog" } };
export const InProgress: Story = { args: { status: "in_progress" } };
export const Done: Story = { args: { status: "done" } };
export const Failed: Story = { args: { status: "failed" } };
export const Blocked: Story = { args: { status: "blocked" } };
export const NewCapture: Story = { args: { status: "new" } };
export const Promoted: Story = { args: { status: "promoted" } };
export const Unknown: Story = { args: { status: "ufo_state" } };
