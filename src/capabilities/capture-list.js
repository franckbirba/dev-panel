import { z } from 'zod';
import { adminGet } from './_http.js';

export const captureList = {
  name: 'capture_list',
  description:
    'List captures with optional filters. Returns a flat array shaped for the CaptureCard renderer. Prefer triage_inbox for "what\'s pending" — this verb is for explicit drilling.',
  paramSchema: z.object({
    status: z.enum(['new', 'triaging', 'promoted', 'dropped']).optional(),
    project_id: z.string().optional().describe('UUID of the project'),
    kind: z.enum(['bug', 'idea']).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  renderHint: 'CaptureList',
  async handler({ status, project_id, kind, limit = 50 }) {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (project_id) qs.set('project_id', project_id);
    if (kind) qs.set('kind', kind);
    qs.set('limit', String(limit));
    const data = await adminGet(`/api/admin/captures?${qs.toString()}`);
    return { captures: data.captures || [] };
  },
};
