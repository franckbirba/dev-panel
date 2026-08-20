import { z } from 'zod';
import { resolvePlaneWorkItem, planeProjectGet } from './_http.js';
import { planWave, nextFront } from '../worker/wave-planner.js';

// ADR-001 — dispatcher une VAGUE d'items ordonnée par les relations Plane
// `blocked_by`, au lieu d'un item à la fois surveillé à la main.
//
// Le re-tick (armer les dépendants quand un blocker merge) est événementiel :
// le webhook GitHub merge-coordinator existe déjà, c'est lui qui rappellera
// le planner. Ici on plante la vague et on dispatche le premier front.

async function fetchBlockedBy(workItemId, projectId) {
  // Plane expose les relations d'un work item ; on ne garde que blocked_by.
  // Toute erreur (endpoint indisponible, item sans relation) → aucun blocker
  // connu : on préfère un ordre plat à un refus de dispatcher.
  try {
    const rel = await planeProjectGet(projectId, `/issues/${workItemId}/relations/`);
    const list = rel?.blocked_by ?? rel?.blocking_issues ?? [];
    return list.map((r) => r.id ?? r.issue ?? r).filter(Boolean);
  } catch {
    return [];
  }
}

export const dispatchWave = {
  name: 'dispatch_wave',
  description:
    'Dispatch a whole ordered wave of Plane work items: topo-sorts them on their blocked_by relations, refuses dependency cycles, and enqueues only the first front (bounded by max_parallel). Dependents are armed as their blockers merge. Use for a refactor or a cycle — "lance la vague Zeno V2" — instead of dispatching items one by one.',
  paramSchema: z.object({
    work_item_ids: z
      .array(z.string())
      .min(1)
      .describe('Sequence ids (ZENO-830) or UUIDs making up the wave.'),
    max_parallel: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(2)
      .describe('How many items may run at once — defaults to 2.'),
    dry_run: z
      .boolean()
      .default(false)
      .describe('Plan and return the fronts without enqueuing anything.'),
  }),
  renderHint: 'JobReceipt',
  async handler({ work_item_ids, max_parallel = 2, dry_run = false }) {
    const resolved = [];
    for (const ref of work_item_ids) {
      const wi = await resolvePlaneWorkItem(ref);
      if (!wi) throw new Error(`Could not resolve "${ref}" — check sequence id and PLANE_API_KEY.`);
      resolved.push(wi);
    }

    const items = [];
    for (const wi of resolved) {
      items.push({ id: wi.id, blocked_by: await fetchBlockedBy(wi.id, wi.project) });
    }

    // planWave lève sur cycle — on laisse remonter : un cycle de dépendances
    // est une erreur de saisie Plane, pas un cas à contourner.
    const plan = planWave(items);
    const byId = new Map(resolved.map((wi) => [wi.id, wi]));
    const label = (id) => byId.get(id)?.name ?? id;
    const front = nextFront(plan, { merged: [], running: [], failed: [], max_parallel });

    if (dry_run) {
      return {
        dry_run: true,
        fronts: plan.fronts.map((f) => f.map(label)),
        would_dispatch: front.map(label),
        max_parallel,
      };
    }

    const { enqueueWorkflowStart } = await import('../worker/dispatch.js');
    const dispatched = [];
    for (const id of front) {
      const wi = byId.get(id);
      const out = await enqueueWorkflowStart({
        workflow: 'work-item',
        plane: { work_item_id: wi.id, project_id: wi.project },
        work_item: {
          title: wi.name,
          description: wi.description_html?.slice(0, 2000) || '',
        },
      });
      dispatched.push({
        work_item_id: wi.id,
        title: wi.name,
        job_id: out.job_id || out.id || out.instance_id,
        refused: out.refused || null,
      });
    }

    return {
      wave_size: plan.items.length,
      fronts: plan.fronts.map((f) => f.map(label)),
      dispatched,
      waiting: plan.items.filter((id) => !front.includes(id)).map(label),
      max_parallel,
      note: 'Les dépendants partiront au merge de leurs blockers (re-tick par le webhook merge-coordinator).',
    };
  },
};
