import type { Meta, StoryObj } from "@storybook/react";
import { ErrorHaltCard } from "@/components/devpanl/ErrorHaltCard";
import { ERROR_HALT_EXAMPLE } from "@/lib/chat-renderer-examples";

const meta: Meta<typeof ErrorHaltCard> = {
  title: "devpanl/ErrorHaltCard",
  component: ErrorHaltCard,
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof ErrorHaltCard>;

export const WithActions: Story = {
  args: { halt: ERROR_HALT_EXAMPLE },
};

export const NoActions: Story = {
  args: {
    halt: { ...ERROR_HALT_EXAMPLE, actions: undefined },
  },
};
