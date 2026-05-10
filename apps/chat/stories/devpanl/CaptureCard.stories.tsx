import type { Meta, StoryObj } from "@storybook/react";
import { CaptureCard } from "@/components/devpanl/CaptureCard";

const meta: Meta<typeof CaptureCard> = {
  title: "devpanl/CaptureCard",
  component: CaptureCard,
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof CaptureCard>;

export const NewBug: Story = {
  args: {
    capture: {
      id: "e5a576ac-97f3-4e9b-bb33-3d1afb0d8d36",
      project_name: "Zeno",
      kind: "bug",
      status: "new",
      content: "Les filtres et le total affiché ne concordent pas",
      reporter: { name: "ghislain gandjonon" },
      created_at: "2026-05-07 19:11",
    },
  },
};

export const Idea: Story = {
  args: {
    capture: {
      id: "id1",
      project_name: "DEVPA",
      kind: "idea",
      status: "new",
      content:
        "Add a /catchup slash command in Shelly that summarizes new captures since last seen.",
      reporter: { name: "Franck" },
      created_at: "2026-05-10 09:14",
    },
  },
};

export const Triaging: Story = {
  args: {
    capture: {
      id: "tr1",
      project_name: "EDMS",
      kind: "bug",
      status: "triaging",
      content: "Upload retry button doesn't appear on 5xx — only on 4xx",
      reporter: { name: "Edwin" },
      created_at: "2026-05-09 16:02",
    },
  },
};

export const Promoted: Story = {
  args: {
    capture: {
      id: "pr1",
      project_name: "Zeno",
      kind: "bug",
      status: "promoted",
      content: "année du bac on peut écrire la lettre 'e'",
      reporter: { name: "Parfait Komko" },
      created_at: "2026-05-07 19:06",
    },
  },
};
