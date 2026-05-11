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
  
  // Diagnostic logging for troubleshooting
  console.log(`[promote_capture] Creating work item in Plane project: ${project_id}`);
  
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'X-API-Key': PLANE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description_html: description || '', priority }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    const errorMsg = `plane create work item → ${r.status}${t ? ': ' + t.slice(0, 200) : ''}`;
    console.error(`[promote_capture] Plane API error: ${errorMsg}. Project ID used: ${project_id}`);
    throw new Error(errorMsg);
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

    // Diagnostic logging to help troubleshoot project ID issues
    console.log(`[promote_capture] Processing capture ${capture_id}`, {
      project_name: c.project_name,
      project_id: c.project_id,  // devpanel project ID
      plane_project_id: c.plane_project_id,  // Plane project UUID
      provided_override: plane_project_id
    });

    // Ensure we have the correct plane project ID
    const targetPlaneProject = plane_project_id || c.plane_project_id;
    if (!targetPlaneProject) {
      throw new Error(
        `capture ${capture_id} is on devpanel project "${c.project_name}" which has no plane_project_id. ` +
        `devpanel project ID: ${c.project_id}, plane_project_id from DB: ${c.plane_project_id}, ` +
        `provided override: ${plane_project_id}. ` +
        `Link the project to Plane via admin UI first.`
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
      console.log(`[promote_capture] Attempting to patch capture ${capture_id} to promoted status`);
      await adminPatch(`/api/admin/captures/${encodeURIComponent(capture_id)}`, {
        status: 'promoted',
        plane_work_item_id: created.id,
        plane_sequence_id: created.sequence_id,
      });
      console.log(`[promote_capture] Successfully patched capture ${capture_id}`);
    } catch (e) {
      patchError = e.message;
      console.error(`[promote_capture] Failed to patch capture ${capture_id} to promoted status: ${e.message}`);
    }

    // Subject-graph edge: capture --[promoted_to]--> work_item.
    // Best-effort — graph write failure must not break the user-visible
    // success of the promotion. Logged in adminPost on failure.
    try {
      console.log(`[promote_capture] Attempting to create subject link for capture ${capture_id} -> work item ${created.id}`);
      const { adminPost } = await import('./_http.js');
      await adminPost('/api/admin/subject-links', {
        from_type: 'capture',
        from_id: capture_id,
        to_type: 'work_item',
        to_id: created.id,
        rel: 'promoted_to',
        source: 'auto',
        meta: {
          plane_sequence_id: created.sequence_id,
          plane_project_id: targetPlaneProject,
        },
      });
      console.log(`[promote_capture] Successfully created subject link`);
    } catch (e) {
      console.warn('[promote_capture] subject-link write failed:', e.message);
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
