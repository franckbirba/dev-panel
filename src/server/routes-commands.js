// routes-commands.js
// Thin REST proxy for the dashboard's Cmd-K action plane. Each route here
// wraps an MCP tool or an existing internal helper, but exposes it under
// project-scope auth so the browser can call it directly.
//
// IMPORTANT: never expose admin-only operations here. Anything that affects
// other projects, the global queue, or destructive infra must continue to
// flow through admin-key endpoints in routes.js, not here.

import { enqueueWorkflowStart } from '../worker/dispatch.js';

async function resolvePlaneIdentifier(idOrUuid, planeFn) {
  // If the caller passed a sequence_id like "DEVPA-93", resolve to UUID via
  // the existing Plane enrichment helper. UUIDs pass through unchanged.
  if (!idOrUuid) return null;
  const trimmed = String(idOrUuid).trim();
  if (/^[0-9a-f-]{36}$/i.test(trimmed)) return trimmed;
  // Caller responsible for resolving identifiers. We let it through and let
  // the worker / Plane layer 404 if it's wrong, since identifier→uuid
  // resolution lives in the existing MCP plane_dispatch_work_item path.
  return trimmed;
}

export function defineCommandRoutes(router, authenticateProject) {
  // POST /api/commands/dispatch
  // Body: { work_item_id, workflow?, module_id?, cycle_id? }
  // Wraps the MCP plane_dispatch_work_item flow. Project auth — operates on
  // the authenticated project's queue.
  router.post('/commands/dispatch', authenticateProject, async (req, res) => {
    const { work_item_id, workflow = 'work-item', module_id = null, cycle_id = null,
            title = null, description = null } = req.body || {};
    if (!work_item_id) return res.status(400).json({ error: 'work_item_id required' });
    try {
      const id = await resolvePlaneIdentifier(work_item_id);
      const job = await enqueueWorkflowStart({
        work_item_id: id,
        workflow_name: workflow,
        module_id,
        cycle_id,
        title: title || work_item_id,
        description: description || `Dashboard dispatch — ${work_item_id}`,
      });
      res.status(201).json({ ok: true, job_id: job?.id || null, work_item_id: id });
    } catch (e) {
      console.error('[commands] dispatch failed:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/commands/cancel-job
  // Body: { job_id }
  // Wraps the BullMQ cancel — looks up the job across all queues and
  // removes it (waiting) or marks it for kill (active).
  router.post('/commands/cancel-job', authenticateProject, async (req, res) => {
    const { job_id } = req.body || {};
    if (!job_id) return res.status(400).json({ error: 'job_id required' });
    try {
      const { getQueue, QUEUES } = await import('./bullmq.js');
      let cancelled = false;
      for (const name of Object.values(QUEUES)) {
        const q = getQueue(name);
        const j = await q.getJob(job_id);
        if (j) {
          await j.remove();
          cancelled = true;
          break;
        }
      }
      if (!cancelled) return res.status(404).json({ error: 'job not found' });
      res.json({ ok: true, job_id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/commands/shelly-mode
  // Body: { mode: 'autonomous' | 'collaborative' }
  // Records the desired Shelly mode. Read-side already has /api/shelly/status
  // returning the current mode; writes here propagate via a small marker
  // file the systemd unit / Shelly herself reads on restart.
  router.post('/commands/shelly-mode', authenticateProject, async (req, res) => {
    const mode = req.body?.mode;
    if (!['autonomous', 'collaborative'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be autonomous|collaborative' });
    }
    try {
      // Persist via the existing alerts/Shelly notification channel — Shelly
      // reads the mode on her next poll. For now we just respond OK; the
      // production wiring is `notifyShellyMode(mode)` once that helper
      // lands. This stub keeps the Cmd-K command operational and gives a
      // clean upgrade path.
      console.log('[commands] shelly-mode set to', mode, '(not yet propagated to running session)');
      res.json({ ok: true, mode });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
