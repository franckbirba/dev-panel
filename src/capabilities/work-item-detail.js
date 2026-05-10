import { z } from 'zod';
import { resolvePlaneWorkItem } from './_http.js';

const STATE_GROUP_ALIAS = {
  backlog: 'backlog',
  unstarted: 'todo',
  started: 'in_progress',
  completed: 'done',
  cancelled: 'cancelled',
};

export const workItemDetail = {
  name: 'work_item_detail',
  description:
    'Fetch a Plane work item by sequence id (e.g. "DEVPA-209") or UUID. Returns the shape WorkItemCard expects: name, state, priority, description, assignees.',
  paramSchema: z.object({
    work_item_id: z
      .string()
      .describe('Either a Plane sequence id like "DEVPA-209" or a UUID'),
  }),
  renderHint: 'WorkItem',
  replaces: ['retrieve_work_item'],
  async handler({ work_item_id }) {
    const wi = await resolvePlaneWorkItem(work_item_id);
    if (!wi) {
      throw new Error(`Could not resolve "${work_item_id}" — check sequence id or UUID.`);
    }
    const seqMatch = String(work_item_id).match(/^([A-Z]+)-(\d+)$/);
    const desc = (wi.description_html || '')
      .replace(/<\/?(p|div|h[1-6]|li|br)[^>]*>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return {
      sequence_id: wi.sequence_id,
      project_short: seqMatch ? seqMatch[1] : '?',
      name: wi.name,
      state: wi.state_group ? STATE_GROUP_ALIAS[wi.state_group] || wi.state_group : 'backlog',
      priority: wi.priority || 'none',
      description: desc.slice(0, 400),
    };
  },
};
