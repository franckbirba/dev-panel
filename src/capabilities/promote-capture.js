import { z } from 'zod';
import { adminGet, adminPatch } from './_http.js';
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
    'Turn a capture into a real Plane work item. Resolves the capture\'s linked Plane project automatically (no need to pass plane_project_id), creates the work item with the drafted title/description/priority, then PATCHes the capture to status=promoted with the new plane refs. Atomic stitch — if anything fails, surface the real error so the chat can fix it.',
  paramSchema: z.object({
    capture_id: z.string(),
    title: z.string().describe('Work item title — keep it action-shaped'),
    description: z.string().optional(),
    priority: z
      .enum(['urgent', 'high', 'medium', 'low', 'none'])
      .default('medium'),
    // Optional override. By default we read plane_project_id from the
    // capture's devpanel project. Pass this only to force a different
    // Plane project (rare — cross-project promotion).
    plane_project_id: z
      .string()
      .optional()
      .describe('Override: Plane project UUID. Defaults to the capture\'s linked Plane project.'),
  }),
  renderHint: 'WorkItem',
  async handler({ capture_id, title, description, priority = 'medium', plane_project_id }) {
    // Resolve the capture so we know which Plane project to target.
    // The admin endpoint surfaces plane_project_id directly (DEVPA-217).
    const data = await adminGet(`/api/admin/captures/${encodeURIComponent(capture_id)}`);
    const c = data.capture || data;
    if (!c) throw new Error(`capture ${capture_id} not found`);

    const targetPlaneProject = plane_project_id || c.plane_project_id;
    if (!targetPlaneProject) {
      throw new Error(
        `capture ${capture_id} is on devpanel project "${c.project_name}" which has no plane_project_id. Link it first via the admin UI, or pass plane_project_id explicitly.`
      );
    }

    const created = await createPlaneWorkItem({
      project_id: targetPlaneProject,
      name: title,
      description,
      priority,
    });

    // Close the loop — mark the capture as promoted with the new Plane refs.
    // Best-effort: if the PATCH fails the WI is already created, so we
    // surface that fact instead of pretending the whole thing succeeded.
    let patchError = null;
    try {
      await adminPatch(`/api/admin/captures/${encodeURIComponent(capture_id)}`, {
        status: 'promoted',
        plane_work_item_id: created.id,
        plane_sequence_id: created.sequence_id,
      });
    } catch (e) {
      patchError = e.message;
    }

    return {
      // Shape matches WorkItemCard's expectations.
      id: created.id,
      sequence_id: created.sequence_id,
      project_id: targetPlaneProject,
      project_short: c.project_name || '?',
      name: created.name,
      state: 'backlog',
      priority,
      capture_id,
      ...(patchError
        ? { _warning: `Plane WI created (${created.sequence_id}) but failed to mark capture promoted: ${patchError}` }
        : {}),
    };
  },
};
