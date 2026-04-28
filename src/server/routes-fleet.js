// routes-fleet.js
// Fleet — one row per running agent / one row per active workflow.
// Joins workflow_instances × agent_job_log × Plane enrichment into a single
// dense feed. Project-auth (same auth model as /api/inbox); the worker host
// only knows about workflow_instances by work_item_id, so we don't filter by
// project here — Plane enrichment surfaces project_name.

import { pool as pgPool } from './pg.js';
import { enrichWorkItems } from './plane-enrich.js';

async function safeQuery(sql, params) {
  try {
    const r = await pgPool.query(sql, params);
    return { ok: true, rows: r.rows };
  } catch (e) {
    return { ok: false, error: e.message, rows: [] };
  }
}

export function defineFleetRoutes(router, authenticateProject) {
  // GET /api/fleet?status=active|all&limit=
  // Returns { agents: [...], shelly: {...} }
  // Each agent row: workflow + last step + autonomy + recency.
  router.get('/fleet', authenticateProject, async (req, res) => {
    const status = req.query.status === 'all' ? 'all' : 'active';
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));

    let where;
    if (status === 'active') {
      where = `WHERE status IN ('running','awaiting_approval','blocked')`;
    } else {
      where = `WHERE last_event_at > now() - interval '24 hours'`;
    }

    const wf = await safeQuery(`
      SELECT id, work_item_id, workflow_name, revision, current_step, status,
             started_at, last_event_at, exhausted_at, last_job_id, metadata
        FROM workflow_instances
        ${where}
        ORDER BY last_event_at DESC NULLS LAST
        LIMIT $1
    `, [limit]);

    if (!wf.ok) {
      return res.json({ agents: [], shelly: { state: 'unknown' }, degraded: true, error: wf.error });
    }

    // Enrich with Plane metadata so the row shows DEVPA-93 + project name
    // instead of a UUID.
    const uuids = wf.rows.map(r => r.work_item_id).filter(Boolean);
    let meta = new Map();
    try {
      meta = await enrichWorkItems(uuids);
    } catch (e) {
      // Degrade — Plane unreachable shouldn't 500 the fleet view.
      console.warn('[fleet] enrichWorkItems failed:', e.message);
    }

    // Pull latest agent step per workflow's last_job_id so the row can show
    // "running tests" or "fetching api" at a glance.
    const jobIds = wf.rows.map(r => r.last_job_id).filter(Boolean);
    const stepsByJob = new Map();
    if (jobIds.length > 0) {
      const stepRes = await safeQuery(`
        SELECT DISTINCT ON (job_id) job_id, step, status, error, duration_ms, timestamp, agent
          FROM agent_job_log
         WHERE job_id = ANY($1::text[])
         ORDER BY job_id, id DESC
      `, [jobIds]);
      for (const s of stepRes.rows) stepsByJob.set(s.job_id, s);
    }

    const agents = wf.rows.map(r => {
      const m = meta.get(r.work_item_id) || {};
      const lastStep = r.last_job_id ? stepsByJob.get(r.last_job_id) : null;
      // Parse metadata to surface autonomy if the worker has stored it. For
      // now autonomy is a follow-up DB column; until that lands we extract
      // from the JSON metadata blob if present.
      let autonomy = 'med';
      try {
        const md = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata;
        if (md?.autonomy && ['low', 'med', 'high'].includes(md.autonomy)) {
          autonomy = md.autonomy;
        }
      } catch { /* metadata may be null or invalid */ }
      return {
        instance_id: r.id,
        work_item_id: r.work_item_id,
        identifier: m.identifier || null,    // DEVPA-93
        title: m.title || null,
        project_name: m.project_name || null,
        plane_url: m.plane_url || null,
        workflow: r.workflow_name,
        revision: r.revision,
        current_step: r.current_step,
        status: r.status,                    // running / awaiting_approval / blocked / done / exhausted
        started_at: r.started_at,
        last_event_at: r.last_event_at,
        exhausted_at: r.exhausted_at,
        last_job_id: r.last_job_id,
        agent: lastStep?.agent || null,
        last_step_status: lastStep?.status || null,
        last_step_error: lastStep?.error || null,
        last_step_duration_ms: lastStep?.duration_ms || null,
        autonomy,
      };
    });

    // Shelly health — read from /shelly/health (in-process). For now we
    // expose what we know via process state. The dashboard already polls
    // /api/shelly/status separately; we surface a single shelly row here
    // marked from a follow-up endpoint or just presence of recent
    // workflow_instance activity.
    const shelly = { state: 'unknown' };
    res.json({ agents, shelly });
  });

  // POST /api/fleet/:instance_id/cancel  — admin-equivalent action wired to
  // workflow cancellation via BullMQ. For now we just record the intent;
  // the fuller integration happens with cancel_job MCP. Authoring this stub
  // so the UI Cancel button has something to call.
  router.post('/fleet/:instance_id/cancel', authenticateProject, async (req, res) => {
    const id = parseInt(req.params.instance_id, 10);
    if (!id) return res.status(400).json({ error: 'instance_id required' });
    try {
      await pgPool.query(
        `UPDATE workflow_instances SET status='cancelled', last_event_at=$2 WHERE id = $1`,
        [id, Date.now()]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/fleet/:instance_id/approve — flips an awaiting_approval
  // instance back to running and re-enqueues the next step. This is the
  // canonical "yes, continue" action for blocked workflows that paused
  // because autonomy=low/med required a human decision before advancing.
  router.post('/fleet/:instance_id/approve', authenticateProject, async (req, res) => {
    const id = parseInt(req.params.instance_id, 10);
    if (!id) return res.status(400).json({ error: 'instance_id required' });
    try {
      const cur = await pgPool.query(
        `SELECT id, work_item_id, workflow_name, current_step, status, metadata
           FROM workflow_instances WHERE id = $1`,
        [id]
      );
      if (cur.rows.length === 0) return res.status(404).json({ error: 'not found' });
      const inst = cur.rows[0];
      if (!['awaiting_approval', 'blocked', 'exhausted'].includes(inst.status)) {
        return res.status(409).json({ error: `cannot approve from status=${inst.status}` });
      }
      // Flip status and re-enqueue the same step. enqueueWorkflowStart
      // accepts a scheduled_for for delays — we want immediate.
      await pgPool.query(
        `UPDATE workflow_instances SET status='running', last_event_at=$2 WHERE id = $1`,
        [id, Date.now()]
      );
      // Best-effort enqueue. enqueueWorkflowStart() lives in the worker
      // module — if we're running inside the API process, it still works
      // because BullMQ writes go to the same Redis. We import lazily so
      // tests that stub bullmq can avoid pulling the worker module.
      try {
        const { enqueueWorkflowStart } = await import('../worker/dispatch.js');
        const result = await enqueueWorkflowStart({
          workflow: inst.workflow_name,
          plane: { work_item_id: inst.work_item_id },
          context: { resume: true, from_status: inst.status },
        });
        if (!result?.ok && result?.error !== 'already_running') {
          console.warn('[fleet/approve] re-enqueue:', result);
        }
      } catch (e) {
        console.warn('[fleet/approve] re-enqueue failed (non-fatal):', e.message);
      }
      res.json({ ok: true, instance_id: id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/fleet/:instance_id/retry — same as approve but explicitly for
  // failed/exhausted instances. Distinct verb so the UI can be honest about
  // what's happening (Approve = "I read it and it's fine", Retry = "this
  // crashed, do it again").
  router.post('/fleet/:instance_id/retry', authenticateProject, async (req, res) => {
    const id = parseInt(req.params.instance_id, 10);
    if (!id) return res.status(400).json({ error: 'instance_id required' });
    try {
      const cur = await pgPool.query(
        `SELECT id, work_item_id, workflow_name, current_step, status
           FROM workflow_instances WHERE id = $1`,
        [id]
      );
      if (cur.rows.length === 0) return res.status(404).json({ error: 'not found' });
      const inst = cur.rows[0];
      await pgPool.query(
        `UPDATE workflow_instances SET status='running', last_event_at=$2 WHERE id = $1`,
        [id, Date.now()]
      );
      try {
        const { enqueueWorkflowStart } = await import('../worker/dispatch.js');
        const result = await enqueueWorkflowStart({
          workflow: inst.workflow_name,
          plane: { work_item_id: inst.work_item_id },
          context: { resume: true, retry: true, from_status: inst.status },
        });
        if (!result?.ok && result?.error !== 'already_running') {
          console.warn('[fleet/retry] re-enqueue:', result);
        }
      } catch (e) {
        console.warn('[fleet/retry] re-enqueue failed (non-fatal):', e.message);
      }
      res.json({ ok: true, instance_id: id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/fleet/:instance_id/autonomy
  // Body: { autonomy: 'low' | 'med' | 'high' }
  // Updates workflow_instances.metadata.autonomy. The worker reads metadata
  // before auto-advancing; this is a leash without schema migration.
  router.post('/fleet/:instance_id/autonomy', authenticateProject, async (req, res) => {
    const id = parseInt(req.params.instance_id, 10);
    const autonomy = req.body?.autonomy;
    if (!id) return res.status(400).json({ error: 'instance_id required' });
    if (!['low', 'med', 'high'].includes(autonomy)) {
      return res.status(400).json({ error: 'autonomy must be low|med|high' });
    }
    try {
      // Read-modify-write the JSON metadata column. last-writer-wins is fine
      // here — autonomy edits are infrequent + per-task.
      const cur = await pgPool.query(
        `SELECT metadata FROM workflow_instances WHERE id = $1`,
        [id]
      );
      if (cur.rows.length === 0) return res.status(404).json({ error: 'not found' });
      let md = {};
      try {
        const raw = cur.rows[0].metadata;
        md = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
      } catch { md = {}; }
      md.autonomy = autonomy;
      await pgPool.query(
        `UPDATE workflow_instances SET metadata = $1, last_event_at = now() WHERE id = $2`,
        [JSON.stringify(md), id]
      );
      res.json({ ok: true, autonomy });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
