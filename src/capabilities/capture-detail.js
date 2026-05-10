import { z } from 'zod';
import { adminGet } from './_http.js';

export const captureDetail = {
  name: 'capture_detail',
  description:
    'Fetch a single capture by id. Use when Franck (or a Talk-about-it action) names a specific capture uuid. Returns the full content, screenshot URL if any, reporter, status, plus the conversation thread (messages between Franck/Shelly/agents about this capture).',
  paramSchema: z.object({
    capture_id: z.string().describe('Capture UUID'),
  }),
  renderHint: 'Capture',
  async handler({ capture_id }) {
    const data = await adminGet(`/api/admin/captures/${encodeURIComponent(capture_id)}`);
    const c = data.capture || data;
    // Forward EVERYTHING the admin endpoint returns, not a curated subset.
    // Earlier version dropped `messages` (the thread history) and `environment`
    // — Shelly then answered "no info on the page concerned" because she
    // literally had less than the row. The CaptureCard renderer only reads
    // the fields it knows; extras pass through to the LLM context.
    return {
      id: c.id,
      project_name: c.project_name,
      project_id: c.project_id,
      kind: c.kind,
      status: c.status,
      content: c.content,
      screenshot_url: c.screenshot_url,
      environment: c.environment,
      external_url: c.external_url,
      fingerprint: c.fingerprint,
      reporter: c.reporter,
      created_at: c.created_at,
      updated_at: c.updated_at,
      plane_work_item_id: c.plane_work_item_id,
      plane_sequence_id: c.plane_sequence_id,
      // Conversation history — every reply Franck/Shelly/agents have made
      // on this capture's thread. Critical for "Talk about it" — without
      // it, Shelly can't see prior triage decisions.
      messages: Array.isArray(c.messages) ? c.messages : [],
    };
  },
};
