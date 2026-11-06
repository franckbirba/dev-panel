import type { Meta, StoryObj } from "@storybook/react";
import { FleetStatusSidebar } from "@/components/devpanl/FleetStatusSidebar";

const meta: Meta<typeof FleetStatusSidebar> = {
  title: "devpanl/FleetStatusSidebar",
  component: FleetStatusSidebar,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof FleetStatusSidebar>;

export const Default: Story = {
  args: {},
  decorators: [
    (Story) => (
      <div className="flex h-screen">
        <div className="w-80">
          <Story />
        </div>
      </div>
    ),
  ],
};