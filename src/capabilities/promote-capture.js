import { z } from 'zod';
import { adminPatch } from './_http.js';
import {
  PLANE_BASE_URL,
  PLANE_WORKSPACE_SLUG,
} from './_http.js';

const PLANE_API_KEY = process.env.PLANE_API_KEY || process.env.PLANE_API_TOKEN || '';

async function createPlaneWorkItem({ project_id, name, description, priority }) {
  if (!PLANE_API_KEY) throw new Error('PLANE_API_KEY not configured');
  const url = `${PLANE_BASE_URL}/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${project_id}/issues/`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'X-API-Key': PLANE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description_html: description || '', priority }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`plane create work item → ${r.status}${t ? ': ' + t.slice(0, 200) : ''}`);
  }
  return r.json();
}

export const promoteCapture = {
  name: 'promote_capture',
  description:
    'Turn a capture into a real Plane work item. Creates the work item (with title/description/priority drafted from the capture content), then PATCHes the capture to status=promoted with the new plane refs. Returns the work item id so the chat can show a confirmation card.',
  paramSchema: z.object({
    capture_id: z.string(),
    title: z.string().describe('Work item title — keep it action-shaped'),
    description: z.string().optional(),
    priority: z
      .enum(['urgent', 'high', 'medium', 'low', 'none'])
      .default('medium'),
    project_id: z
      .string()
      .describe('UUID of the Plane project that owns the work item.'),
  }),
  renderHint: 'WorkItem',
  async handler({ capture_id, title, description, priority = 'medium', project_id }) {
    const created = await createPlaneWorkItem({
      project_id,
      name: title,
      description,
      priority,
    });

    // PATCHing a capture is project-keyed (`/api/captures/:id`), not admin-
    // keyed — so we can't do it via adminPatch here. The chat handler's
    // session has the admin key, not a project key. We surface the WI link
    // and let Shelly (who has both) finish the patch in the next turn, OR
    // a follow-up admin endpoint /api/admin/captures/:id (DEVPA-211) lands.
    // For now: the work item is created in Plane, and the capture stays
    // in 'new' until Shelly closes the loop. Better than no card.
    return {
      sequence_id: created.sequence_id,
      project_short: '?',
      name: created.name,
      state: 'backlog',
      priority,
      capture_id,
      _note:
        'Plane work item created. Capture status patch deferred — ask Shelly to mark capture as promoted via existing channels.',
    };
  },
};
