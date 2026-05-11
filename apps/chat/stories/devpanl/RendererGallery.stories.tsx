import type { Meta, StoryObj } from "@storybook/react";
import { ALL_RENDERER_EXAMPLES } from "@/lib/chat-renderer-examples";
import type { RendererPayload } from "@/lib/chat-renderer-types";
import { RendererPayloadView } from "@/lib/tool-ui-registry";

// Gallery story for DEVPA-210 — proves the dispatch path renders every
// variant declared in chat-renderer-types via the default dashboard
// registry. Each per-card story under stories/devpanl/*Card.stories.tsx
// covers the component in isolation; this story covers the dispatcher.

function Gallery({ examples }: { examples: RendererPayload[] }) {
	return (
		<div className="flex w-[640px] flex-col gap-4 p-4">
			{examples.map((payload) => (
				<div
					key={payload.type}
					className="rounded-lg border border-dashed border-[var(--color-border)] p-3"
				>
					<div className="mb-2 font-mono text-[10.5px] uppercase tracking-wide text-[var(--color-foreground-faint)]">
						{payload.type}
					</div>
					<RendererPayloadView payload={payload} />
				</div>
			))}
		</div>
	);
}

const meta: Meta<typeof Gallery> = {
	title: "devpanl/RendererGallery",
	component: Gallery,
	parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof Gallery>;

export const AllVariants: Story = {
	args: { examples: ALL_RENDERER_EXAMPLES },
};
