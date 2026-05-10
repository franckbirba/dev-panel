import { z } from 'zod';
import { adminGet } from './_http.js';

export const fleetStatus = {
  name: 'fleet_status',
  description:
    'Live BullMQ + worker fleet snapshot: queued/running/awaiting_approval/blocked/failed/completed jobs with state, agent, work-item, step, duration, tokens, spend. Use when Franck asks "what\'s the fleet doing" / "qui tourne" / before he intervenes on a job.',
  paramSchema: z.object({
    state: z
      .enum(['active', 'all'])
      .optional()
      .describe('Defaults to active (running + queued + awaiting_approval + blocked).'),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  renderHint: 'FleetList',
  async handler({ state = 'active', limit = 50 }) {
    // Use the admin workflows endpoint which surfaces instance state
    // without a project key. Per src/server/routes.js#2147.
    const data = await adminGet(
      `/api/admin/workflows/instances?status=${encodeURIComponent(state)}&limit=${limit}`
    );
    const instances = data.instances || data || [];
    const rows = instances.slice(0, limit).map((i) => ({
      job_id: i.last_job_id || i.id,
      agent: i.current_step || i.workflow_name || 'agent',
      work_item_short: i.work_item_short || i.work_item_id?.slice(0, 8) || '?',
      state:
        i.status === 'awaiting_approval'
          ? 'awaiting_approval'
          : i.status === 'blocked'
            ? 'blocked'
            : i.status === 'failed' || i.status === 'exhausted'
              ? 'failed'
              : i.status === 'succeeded' || i.status === 'completed'
                ? 'completed'
                : i.status === 'cancelled'
                  ? 'completed'
                  : 'running',
      step: i.current_step,
      duration_seconds: i.started_at
        ? Math.round((Date.now() - new Date(i.started_at).getTime()) / 1000)
        : 0,
    }));
    return { rows };
  },
};
