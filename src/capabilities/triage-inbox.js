import { z } from 'zod';
import { adminGet } from './_http.js';

export const triageInbox = {
  name: 'triage_inbox',
  description:
    'Show the capture inbox at a glance: counts per project + the N most recent untriaged captures. Use when Franck asks "what\'s in the inbox" / "ça donne quoi sur les captures" / before the morning digest.',
  paramSchema: z.object({
    limit: z.number().int().min(1).max(50).default(10).describe('Max recent captures to surface'),
  }),
  renderHint: 'CaptureList',
  replaces: ['list_captures'],
  async handler({ limit = 10 }) {
    const data = await adminGet(
      `/api/admin/captures?status=new&limit=${Math.min(limit, 200)}`
    );
    const list = data.captures || [];
    const byProject = {};
    for (const c of list) {
      const k = c.project_name || 'unknown';
      byProject[k] = (byProject[k] || 0) + 1;
    }
    return {
      total_new: list.length,
      by_project: byProject,
      captures: list.slice(0, limit).map((c) => ({
        id: c.id,
        project_name: c.project_name,
        kind: c.kind,
        status: c.status,
        content: c.content,
        screenshot_url: c.screenshot_url,
        reporter: c.reporter,
        created_at: c.created_at,
      })),
    };
  },
};
