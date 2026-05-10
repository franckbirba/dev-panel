import type { Meta, StoryObj } from "@storybook/react";
import { RuntimeConsoleCard } from "@/components/devpanl/RuntimeConsoleCard";

const meta: Meta<typeof RuntimeConsoleCard> = {
  title: "devpanl/RuntimeConsoleCard",
  component: RuntimeConsoleCard,
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof RuntimeConsoleCard>;

const SAMPLE_LINES = [
  "May 10 16:42:01 hetzner-vps shelly[1234]: starting telegram-multi poller",
  "May 10 16:42:01 hetzner-vps shelly[1234]: registered 4 dev_bots",
  "May 10 16:42:02 hetzner-vps shelly[1234]: [bot:franck] polling getUpdates offset=0",
  "May 10 16:42:03 hetzner-vps shelly[1234]: [bot:franck] received message from 5663177530",
  "May 10 16:42:03 hetzner-vps shelly[1234]: [bot:franck] inbound \"qu'est-ce qui bloque?\"",
  "May 10 16:42:04 hetzner-vps shelly[1234]: claude responding via stdio MCP transport",
];

export const Connected: Story = {
  args: {
    title: "shelly.service",
    lines: SAMPLE_LINES,
    state: "connected",
  },
};

export const Reconnecting: Story = {
  args: {
    title: "devpanel-worker.service",
    lines: SAMPLE_LINES.slice(0, 2),
    state: "reconnecting",
  },
};

export const Disconnected: Story = {
  args: {
    title: "telegram-multi",
    lines: [],
    state: "disconnected",
  },
};
