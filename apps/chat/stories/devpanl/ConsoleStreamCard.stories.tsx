import type { Meta, StoryObj } from "@storybook/react";
import { ConsoleStreamCard } from "@/components/devpanl/ConsoleStreamCard";
import { CONSOLE_STREAM_EXAMPLE } from "@/lib/chat-renderer-examples";

const meta: Meta<typeof ConsoleStreamCard> = {
  title: "devpanl/ConsoleStreamCard",
  component: ConsoleStreamCard,
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof ConsoleStreamCard>;

export const Connected: Story = {
  args: { stream: CONSOLE_STREAM_EXAMPLE },
};

export const Reconnecting: Story = {
  args: {
    stream: {
      ...CONSOLE_STREAM_EXAMPLE,
      state: "reconnecting",
      lines: CONSOLE_STREAM_EXAMPLE.lines.slice(0, 2),
    },
  },
};

export const Disconnected: Story = {
  args: {
    stream: { ...CONSOLE_STREAM_EXAMPLE, state: "disconnected", lines: [] },
  },
};
