import type { Meta, StoryObj } from "@storybook/react";
import { QueueCard } from "@/components/devpanl/QueueCard";
import { QUEUE_CARD_EXAMPLE } from "@/lib/chat-renderer-examples";

const meta: Meta<typeof QueueCard> = {
  title: "devpanl/QueueCard",
  component: QueueCard,
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof QueueCard>;

export const EnvInjection: Story = {
  args: { queue: QUEUE_CARD_EXAMPLE },
};

export const AllApproved: Story = {
  args: {
    queue: {
      ...QUEUE_CARD_EXAMPLE,
      items: QUEUE_CARD_EXAMPLE.items.map((i) => ({
        ...i,
        state: "approved" as const,
        actions: undefined,
      })),
      footer: "All set",
    },
  },
};
