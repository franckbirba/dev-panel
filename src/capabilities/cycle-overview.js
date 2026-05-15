import { z } from 'zod';
import { planeProjectGet, planeWorkspaceGet } from './_http.js';

const STATE_GROUP_ALIAS = {
  backlog: 'backlog',
  unstarted: 'todo',
  started: 'in_progress',
  completed: 'done',
  cancelled: 'cancelled',
};

function daysBetween(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, Math.round((new Date(b) - new Date(a)) / 86_400_000));
}

export const cycleOverview = {
  name: 'cycle_overview',
  description:
    'Snapshot of a Plane cycle: name, dates, days remaining, counts (done/in_progress/backlog/blockers), and the work items in it. Stitches list_cycles + list_cycle_work_items + list_states. Defaults to the active cycle of the named project.',
  paramSchema: z.object({
    project_short: z
      .string()
      .describe('Project identifier like "DEVPA". Required.'),
    cycle_id: z
      .string()
      .optional()
      .describe('Specific cycle UUID. Omit for the current/active cycle.'),
  }),
  renderHint: 'SprintProgress',
  replaces: ['list_cycles', 'list_cycle_work_items', 'list_states'],
  async handler({ project_short, cycle_id }) {
    // Resolve project_short → plane_project_id by asking Plane directly. The
    // managed-projects table (`/api/admin/projects`) doesn't store the Plane
    // identifier ("DEVPA"/"ZENO"/...), only the UUID + repo name, so we
    // can't match on it. Plane's `/projects/` endpoint has `identifier`.
    const upper = project_short.toUpperCase();
    const planeProjects = (await planeWorkspaceGet('/projects/')).results || [];
    const planeProj = planeProjects.find(
      (p) => (p.identifier || '').toUpperCase() === upper
    );
    if (!planeProj) {
      throw new Error(
        `No Plane project found with identifier "${project_short}". Known: ${planeProjects.map((p) => p.identifier).filter(Boolean).join(', ')}`
      );
    }
    const planeProjectId = planeProj.id;

    // 2. Resolve cycle (active by default)
    let cycle;
    if (cycle_id) {
      const cycles = await planeProjectGet(planeProjectId, '/cycles/');
      cycle =
        (cycles.results || cycles).find((c) => c.id === cycle_id) || null;
    } else {
      const cycles = await planeProjectGet(planeProjectId, '/cycles/?cycle_view=current');
      const list = cycles.results || cycles || [];
      cycle = Array.isArray(list) ? list[0] : null;
      if (!cycle) {
        // Fallback — pick the first cycle whose end_date is in the future
        const all = (await planeProjectGet(planeProjectId, '/cycles/')).results || [];
        const now = new Date();
        cycle =
          all.find(
            (c) =>
              c.end_date &&
              new Date(c.end_date) >= now &&
              c.start_date &&
              new Date(c.start_date) <= now
          ) || all[all.length - 1];
      }
    }
    if (!cycle) throw new Error(`No cycle found for ${project_short}`);

    // 3. Get cycle work items
    const wiRes = await planeProjectGet(
      planeProjectId,
      `/cycles/${cycle.id}/cycle-issues/`
    );
    const wis = wiRes.results || wiRes || [];

    // 4. Get states (for state_group resolution)
    const statesRes = await planeProjectGet(planeProjectId, '/states/');
    const states = statesRes.results || statesRes || [];
    const stateById = new Map(states.map((s) => [s.id, s.group]));

    let done = 0,
      inProgress = 0,
      backlog = 0,
      blockers = 0;
    const work_items = wis.slice(0, 12).map((wi) => {
      const group = stateById.get(wi.state) || 'backlog';
      const mapped = STATE_GROUP_ALIAS[group] || 'backlog';
      if (mapped === 'done') done++;
      else if (mapped === 'in_progress') inProgress++;
      else backlog++;
      return {
        sequence_id: wi.sequence_id,
        project_short,
        name: wi.name,
        state: mapped,
      };
    });

    return {
      cycle_name: cycle.name,
      start_date: cycle.start_date || '',
      end_date: cycle.end_date || '',
      days_remaining: daysBetween(new Date(), cycle.end_date),
      total: wis.length,
      done,
      in_progress: inProgress,
      backlog,
      blockers,
      work_items,
    };
  },
};
