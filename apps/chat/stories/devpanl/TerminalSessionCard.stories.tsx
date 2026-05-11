import type { Meta, StoryObj } from "@storybook/react";
import { TerminalSessionCard } from "@/components/devpanl/TerminalSessionCard";
import { TERMINAL_SESSION_EXAMPLE } from "@/lib/chat-renderer-examples";

const meta: Meta<typeof TerminalSessionCard> = {
  title: "devpanl/TerminalSessionCard",
  component: TerminalSessionCard,
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof TerminalSessionCard>;

export const Live: Story = {
  args: { session: TERMINAL_SESSION_EXAMPLE },
};

export const NoMetrics: Story = {
  args: {
    session: {
      ...TERMINAL_SESSION_EXAMPLE,
      metrics: undefined,
      security: undefined,
    },
  },
};
