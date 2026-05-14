// routes-fleet.js
// Fleet — one row per running agent / one row per active workflow.
// Joins workflow_instances × agent_job_log × Plane enrichment into a single
// dense feed. Project-auth (same auth model as /api/inbox); the worker host
// only knows about workflow_instances by work_item_id, so we don't filter by
// project here — Plane enrichment surfaces project_name.

import { pool as pgPool } from './pg.js';
import { enrichWorkItems } from './plane-enrich.js';
import {
  postQuestion as inboxPostQuestion,
  postReply as inboxPostReply,
  readNextReply as inboxReadNextReply,
  cancelPending as inboxCancelPending,
  listForJob as inboxListForJob,
} from './job-inbox.js';
import { updateInstance as updateWorkflowInstance } from './workflow-instances.js';
import {
  sendInboxQuestion as tgSendInboxQuestion,
  confirmReply as tgConfirmReply,
  resolveForceReply as tgResolveForceReply,
  clearPendingReply as tgClearPendingReply,
} from './telegram-hitl.js';

async function safeQuery(sql, params) {
  try {
    const r = await pgPool.query(sql, params);
    return { ok: true, rows: r.rows };
  } catch (e) {
    return { ok: false, error: e.message, rows: [] };
  }
}

// Local-dev fallback: when local Postgres isn't running (Mac dev), proxy the
// fleet view from prod. Two transports tried in order:
//   1. PROD_API_BASE + /api/admin/fleet (admin-keyed alias) — once deployed.
//   2. PROD_MCP_URL via Bearer admin → tools/call list_jobs — works today.
// Either source returns a { agents } shape the UI can render. Source 2
// returns BullMQ jobs (live workers), source 1 returns workflow_instances.
async function fetchProdFleet(query) {
  const base = process.env.PROD_API_BASE;
  const mcpUrl = process.env.PROD_MCP_URL || (base ? `${base.replace(/\/$/, '')}/mcp` : null);
  const key = process.env.ADMIN_API_KEY;
  if (!key) return null;

  // 1. Prefer the admin alias if it exists.
  if (base) {
    try {
      const url = new URL('/api/admin/fleet', base);
      if (query.status) url.searchParams.set('status', query.status);
      if (query.limit) url.searchParams.set('limit', String(query.limit));
      const r = await fetch(url, {
        headers: { 'X-Admin-Key': key },
        signal: AbortSignal.timeout(4000),
      });
      if (r.ok) return await r.json();
    } catch { /* fall through to MCP */ }
  }

  // 2. MCP transport — call list_jobs and project the result into the
  //    {agents:[]} shape the UI consumes. We map BullMQ jobs onto the
  //    same row schema (instance_id ← job id, workflow ← name prefix,
  //    work_item_id ← name suffix, status ← active|waiting|delayed).
  if (mcpUrl) {
    try {
      const sid = await mcpInitialize(mcpUrl, key);
      if (!sid) return null;
      const jobs = await mcpCallListJobs(mcpUrl, key, sid, query);
      if (!Array.isArray(jobs)) return null;
      const agents = jobs.map((j) => {
        const [workflow, work_item_id] = String(j.name || '').split(':');
        return {
          instance_id: j.id,
          work_item_id: work_item_id || null,
          identifier: null,
          title: null,
          project_name: null,
          plane_url: null,
          workflow: workflow || j.agent || 'job',
          revision: null,
          current_step: j.agent || null,
          status: 'running',
          started_at: j.created || null,
          last_event_at: j.created || null,
          exhausted_at: null,
          last_job_id: j.id,
          agent: j.agent || null,
          last_step_status: null,
          last_step_error: null,
          last_step_duration_ms: null,
          autonomy: 'med',
        };
      });
      return { agents, shelly: { state: 'unknown' } };
    } catch { /* swallow */ }
  }

  return null;
}

async function mcpInitialize(url, key) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'devpanel-local-dev', version: '1' },
      },
    }),
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) return null;
  const sid = r.headers.get('mcp-session-id');
  // consume body so the SSE stream closes
  await r.text().catch(() => {});
  // send initialized notification
  await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sid,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(3000),
  }).then((rr) => rr.text()).catch(() => {});
  return sid;
}

async function mcpCallListJobs(url, key, sid, query) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sid,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'list_jobs',
        arguments: {
          state: query.status === 'all' ? 'all' : 'active',
          limit: query.limit || 100,
        },
      },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const text = await r.text();
  // SSE: parse "data: {...}" lines, take last one with a result.
  const lines = text.split('\n').filter(l => l.startsWith('data: '));
  if (!lines.length) return null;
  const last = lines[lines.length - 1].slice(6);
  const env = JSON.parse(last);
  const content = env?.result?.content?.[0]?.text;
  if (!content) return null;
  return JSON.parse(content);
}

export function defineFleetRoutes(router, authenticateProject, authenticateAdmin = null, authenticateSpaBootstrap = null) {
  // Auth helper for inbox endpoints: dashboard uses project key (X-API-Key),
  // the agent's MCP context uses admin key (X-Admin-Key). Accept either.
  // If authenticateAdmin isn't provided (older callers / tests), fall back
  // to project-only.
  function authenticateProjectOrAdmin(req, res, next) {
    if (req.headers['x-admin-key'] && authenticateAdmin) {
      return authenticateAdmin(req, res, next);
    }
    return authenticateProject(req, res, next);
  }

  // Read-only fleet view: SSO session (forwarded user) or admin/project keys.
  // Falls back to project-auth in older callers / tests where SPA bootstrap
  // wasn't provided.
  const fleetReadAuth = authenticateSpaBootstrap
    ? function (req, res, next) {
        if (req.headers['x-api-key']) return authenticateProject(req, res, next);
        return authenticateSpaBootstrap(req, res, next);
      }
    : authenticateProject;

  // GET /api/fleet?status=active|all&limit=
  // Returns { agents: [...], shelly: {...} }
  // Each agent row: workflow + last step + autonomy + recency.
  // Also mounted as /api/admin/fleet (admin-key auth) so local dev sessions
  // can proxy this view from prod when local Postgres is unavailable.
  async function fleetHandler(req, res) {
    const status = req.query.status === 'all' ? 'all' : 'active';
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));

    let where;
    if (status === 'active') {
      where = `WHERE status IN ('running','awaiting_approval','awaiting_input','blocked')`;
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
      const prod = await fetchProdFleet({ status, limit });
      if (prod && Array.isArray(prod.agents)) {
        return res.json({ ...prod, source: 'prod' });
      }
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
  }

  router.get('/fleet', fleetReadAuth, fleetHandler);
  if (authenticateAdmin) {
    router.get('/admin/fleet', authenticateAdmin, fleetHandler);
  }

  // POST /api/fleet/:instance_id/cancel  — admin-equivalent action wired to
  // workflow cancellation via BullMQ. For now we just record the intent;
  // the fuller integration happens with cancel_job MCP. Authoring this stub
  // so the UI Cancel button has something to call.
  router.post('/fleet/:instance_id/cancel', authenticateProject, async (req, res) => {
    const id = parseInt(req.params.instance_id, 10);
    if (!id) return res.status(400).json({ error: 'instance_id required' });
    try {
      const cur = await pgPool.query(
        `SELECT last_job_id FROM workflow_instances WHERE id = $1`,
        [id]
      );
      await pgPool.query(
        `UPDATE workflow_instances SET status='cancelled', last_event_at=$2 WHERE id = $1`,
        [id, Date.now()]
      );
      // Cancel any pending await_human row so the agent's long-poll exits
      // cleanly instead of hanging until timeout.
      const lastJobId = cur.rows[0]?.last_job_id;
      if (lastJobId) {
        try {
          await inboxCancelPending({ job_id: lastJobId });
        } catch (e) {
          console.warn('[fleet/cancel] inbox cancel failed (non-fatal):', e.message);
        }
      }
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

  // ============================================================================
  // HITL inbox — `await_human` primitive.
  // Spec: docs/superpowers/specs/2026-05-09-agent-interactivity-v2-design.md
  //
  // Auth: project key (dashboard) OR admin key (agent's MCP context). Both
  // routes must accept either, since the same surface is read/written by
  // dashboard humans and the running agent.
  // ============================================================================

  // POST /api/jobs/:job_id/inbox/question
  // Called by the await_human MCP tool when the agent needs human input.
  // Body: { kind: 'clarification' | 'tool_approval', content: object }
  // Side effect: flips the matching workflow_instance to 'awaiting_input' so
  // the dashboard renders the right state.
  router.post('/jobs/:job_id/inbox/question', authenticateProjectOrAdmin, async (req, res) => {
    const { job_id } = req.params;
    const { kind, content, work_item_id, workflow_name } = req.body || {};
    if (!job_id) return res.status(400).json({ error: 'job_id required' });
    if (!['clarification', 'tool_approval'].includes(kind)) {
      return res.status(400).json({ error: 'kind must be clarification or tool_approval' });
    }
    if (!content || typeof content !== 'object') {
      return res.status(400).json({ error: 'content object required' });
    }
    try {
      const row = await inboxPostQuestion({ job_id, kind, content });
      // Best-effort flip the workflow status. Some callers may not have a
      // workflow_instance (e.g. ad-hoc jobs) — don't fail the question post
      // on a missing instance.
      if (work_item_id && workflow_name) {
        try {
          await updateWorkflowInstance(
            { work_item_id, workflow_name },
            { status: 'awaiting_input' }
          );
        } catch (e) {
          console.warn('[inbox/question] workflow flip failed (non-fatal):', e.message);
        }
      }
      // Fire-and-forget Telegram send — must not block the agent's
      // long-poll if Telegram is unreachable, and must not 500 the
      // question post.
      tgSendInboxQuestion({
        job_id,
        inbox_seq: row.seq,
        kind,
        content,
      }).catch(err => console.warn('[inbox/question] telegram send failed (non-fatal):', err.message));
      res.status(201).json({ ok: true, question: row });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/jobs/:job_id/inbox/reply
  // Called by the dashboard reply composer or the Telegram callback handler
  // when a human answers the agent's question.
  // Body: { answer: string, callback_query_id?: string, source?: 'dashboard'|'telegram'|'shelly' }
  router.post('/jobs/:job_id/inbox/reply', authenticateProjectOrAdmin, async (req, res) => {
    const { job_id } = req.params;
    const {
      answer, callback_query_id, source, work_item_id, workflow_name,
      tg_chat_id, tg_message_id, original_prompt,
    } = req.body || {};
    if (!job_id) return res.status(400).json({ error: 'job_id required' });
    if (typeof answer !== 'string' || !answer.trim()) {
      return res.status(400).json({ error: 'answer string required' });
    }
    try {
      const result = await inboxPostReply({
        job_id,
        answer: answer.trim(),
        callback_query_id: callback_query_id || null,
        source: source || 'dashboard',
      });
      // Flip the workflow status back to running so the worker resumes it.
      if (!result.duplicate && work_item_id && workflow_name) {
        try {
          await updateWorkflowInstance(
            { work_item_id, workflow_name },
            { status: 'running' }
          );
        } catch (e) {
          console.warn('[inbox/reply] workflow flip failed (non-fatal):', e.message);
        }
      }
      // If the reply came from Telegram (tg_chat_id + tg_message_id
      // provided), update the original message in-place to show the
      // chosen answer, and drop any ForceReply pending-row.
      if (!result.duplicate && tg_chat_id != null && tg_message_id != null) {
        tgConfirmReply({
          tg_chat_id,
          tg_message_id,
          original_prompt: original_prompt || null,
          answer: answer.trim(),
          source: source || 'telegram',
        }).catch(err => console.warn('[inbox/reply] tg edit failed:', err.message));
        tgClearPendingReply({ tg_chat_id, tg_message_id })
          .catch(err => console.warn('[inbox/reply] tg clear failed:', err.message));
      }
      res.json({ ok: true, ...result });
    } catch (e) {
      // "no pending question" is a 409 (conflict) not a 500 — caller raced.
      if (/no pending question/.test(e.message)) {
        return res.status(409).json({ error: e.message });
      }
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/jobs/:job_id/inbox?after_seq=N
  // Used by the await_human MCP tool to long-poll for the human's answer.
  // Returns 200 with { reply } if a row arrived, or 204 if nothing yet.
  router.get('/jobs/:job_id/inbox', authenticateProjectOrAdmin, async (req, res) => {
    const { job_id } = req.params;
    const after_seq = parseInt(req.query.after_seq, 10) || 0;
    if (!job_id) return res.status(400).json({ error: 'job_id required' });
    try {
      const reply = await inboxReadNextReply({ job_id, after_seq });
      if (!reply) return res.status(204).end();
      res.json({ reply });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/jobs/:job_id/inbox/history
  // Full transcript for the dashboard to render.
  router.get('/jobs/:job_id/inbox/history', authenticateProjectOrAdmin, async (req, res) => {
    const { job_id } = req.params;
    if (!job_id) return res.status(400).json({ error: 'job_id required' });
    try {
      const rows = await inboxListForJob(job_id);
      res.json({ messages: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/telegram/inbox/resolve?chat_id=&message_id=
  // Plugin-side helper: resolve a Telegram message_id (the bot's outbound
  // question) to its job_id + inbox_seq. Used by the ForceReply handler in
  // plugins/telegram-multi/server.ts before POSTing to /inbox/reply.
  // Admin-key only — this is plugin-internal plumbing, not a public surface.
  router.get('/telegram/inbox/resolve', async (req, res) => {
    if (!authenticateAdmin) {
      return res.status(501).json({ error: 'admin auth not configured' });
    }
    authenticateAdmin(req, res, async () => {
      const tg_chat_id = req.query.chat_id;
      const tg_message_id = req.query.message_id;
      if (!tg_chat_id || !tg_message_id) {
        return res.status(400).json({ error: 'chat_id and message_id required' });
      }
      try {
        const found = await tgResolveForceReply({ tg_chat_id, tg_message_id });
        if (!found) return res.status(404).json({ error: 'not found' });
        res.json({ ok: true, ...found });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  });

  // POST /api/jobs/:job_id/inbox/cancel
  // Marks pending agent_question rows as cancelled. Used by the workflow
  // cancellation path so a paused agent doesn't long-poll forever.
  router.post('/jobs/:job_id/inbox/cancel', authenticateProjectOrAdmin, async (req, res) => {
    const { job_id } = req.params;
    if (!job_id) return res.status(400).json({ error: 'job_id required' });
    try {
      const result = await inboxCancelPending({ job_id });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
