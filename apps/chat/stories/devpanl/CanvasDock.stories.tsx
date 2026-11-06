import type { Meta, StoryObj } from "@storybook/react";
import { CanvasDock } from "@/components/devpanl/CanvasDock";

const meta: Meta<typeof CanvasDock> = {
  title: "devpanl/CanvasDock",
  component: CanvasDock,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof CanvasDock>;

export const Default: Story = {
  args: {},
  decorators: [
    (Story) => (
      <div className="flex h-screen">
        <div className="w-96 ml-auto">
          <Story />
        </div>
      </div>
    ),
  ],
};