import { z } from 'zod';
import { adminGet } from './_http.js';

export const captureDetail = {
  name: 'capture_detail',
  description:
    'Fetch a single capture by id. Use when Franck (or a Talk-about-it action) names a specific capture uuid — returns the full content, screenshot URL, reporter, status. Pairs 1:1 with CaptureCard.',
  paramSchema: z.object({
    capture_id: z.string().describe('Capture UUID'),
  }),
  renderHint: 'Capture',
  async handler({ capture_id }) {
    const data = await adminGet(`/api/admin/captures/${encodeURIComponent(capture_id)}`);
    const c = data.capture || data;
    return {
      id: c.id,
      project_name: c.project_name,
      project_id: c.project_id,
      kind: c.kind,
      status: c.status,
      content: c.content,
      screenshot_url: c.screenshot_url,
      reporter: c.reporter,
      created_at: c.created_at,
      plane_work_item_id: c.plane_work_item_id,
      plane_sequence_id: c.plane_sequence_id,
    };
  },
};
