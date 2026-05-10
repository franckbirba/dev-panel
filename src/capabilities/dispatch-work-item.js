import { z } from 'zod';
import { resolvePlaneWorkItem } from './_http.js';

export const dispatchWorkItem = {
  name: 'dispatch_work_item',
  description:
    'Hand a Plane work item to the BullMQ fleet for an agent to execute. Accepts a sequence id (DEVPA-93) or UUID. Use when Franck says "lance ZENO-42" / "dispatch this".',
  paramSchema: z.object({
    work_item_id: z
      .string()
      .describe('Sequence id like "DEVPA-93" or a Plane UUID'),
    agent: z
      .enum(['builder', 'reviewer', 'qa', 'designer', 'pm', 'merge-coordinator'])
      .default('builder')
      .describe('Which agent to spawn — defaults to builder.'),
  }),
  renderHint: 'JobReceipt',
  replaces: ['plane_dispatch_work_item'],
  async handler({ work_item_id, agent = 'builder' }) {
    const wi = await resolvePlaneWorkItem(work_item_id);
    if (!wi) {
      throw new Error(
        `Could not resolve "${work_item_id}" — check sequence id and PLANE_API_KEY.`
      );
    }
    // Reuse the worker's enqueue helper directly — same path Shelly uses.
    const { enqueueWorkflowStart } = await import('../worker/dispatch.js');
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: wi.id, project_id: wi.project },
      work_item: { title: wi.name, description: wi.description_html?.slice(0, 2000) || '' },
    });
    return {
      job_id: out.job_id || out.id || out.instance_id,
      work_item_id,
      agent,
      state: 'queued',
    };
  },
};
