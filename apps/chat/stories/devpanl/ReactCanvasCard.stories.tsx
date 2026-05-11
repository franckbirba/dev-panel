import type { Meta, StoryObj } from "@storybook/react";
import { ReactCanvasCard } from "@/components/devpanl/ReactCanvasCard";
import { REACT_CANVAS_EXAMPLE } from "@/lib/chat-renderer-examples";

const meta: Meta<typeof ReactCanvasCard> = {
  title: "devpanl/ReactCanvasCard",
  component: ReactCanvasCard,
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof ReactCanvasCard>;

export const CodeView: Story = {
  args: { canvas: REACT_CANVAS_EXAMPLE },
};

export const NoSlots: Story = {
  args: {
    canvas: { ...REACT_CANVAS_EXAMPLE, slots: undefined, bundle_size: undefined },
  },
};
