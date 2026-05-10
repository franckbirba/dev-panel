import type { Meta, StoryObj } from "@storybook/react";
import { StatusBar } from "@/components/devpanl/StatusBar";

const meta: Meta<typeof StatusBar> = {
  title: "devpanl/StatusBar",
  component: StatusBar,
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof StatusBar>;

export const Cheap: Story = {
  args: {
    usage: {
      session: { tokens: 8_400, cost_usd: 0.012 },
      last24h: { tokens: 280_000, cost_usd: 0.41 },
      provider: "Qwen3-Coder · DeepInfra",
    },
  },
};

export const Medium: Story = {
  args: {
    usage: {
      session: { tokens: 38_000, cost_usd: 0.78 },
      last24h: { tokens: 1_200_000, cost_usd: 18.4 },
      provider: "Claude Sonnet 4.6",
    },
  },
};

export const Expensive: Story = {
  args: {
    usage: {
      session: { tokens: 124_000, cost_usd: 4.31 },
      last24h: { tokens: 3_800_000, cost_usd: 142.5 },
      provider: "Claude Opus 4.7",
    },
  },
};
