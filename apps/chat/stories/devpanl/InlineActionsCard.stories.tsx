import type { Meta, StoryObj } from "@storybook/react";
import { InlineActionsCard } from "@/components/devpanl/InlineActionsCard";
import { INLINE_ACTIONS_EXAMPLE } from "@/lib/chat-renderer-examples";

const meta: Meta<typeof InlineActionsCard> = {
  title: "devpanl/InlineActionsCard",
  component: InlineActionsCard,
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof InlineActionsCard>;

export const FourChips: Story = {
  args: { ...INLINE_ACTIONS_EXAMPLE },
};

export const TwoChips: Story = {
  args: {
    prompt: "Continue?",
    actions: [
      { id: "yes", label: "Yes", variant: "primary" },
      { id: "no", label: "No" },
    ],
  },
};

export const Destructive: Story = {
  args: {
    prompt: "This will drop the running job.",
    actions: [
      { id: "drop", label: "Drop", variant: "danger" },
      { id: "keep", label: "Keep" },
    ],
  },
};
