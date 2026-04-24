// src/server/jobs-events.js
// Persistence + SSE fan-out for agent job events from claude -p stream-json.
// See src/worker/stream-parser.js for the event shape. Persistence is on
// shared pg (migration 003); the SSE subscriber Map is per-process, used
// for live tail-follow on GET /api/admin/jobs/:id/events?stream=1.

import { pool } from './pg.js';

// Per-job SSE subscriber pools.
const subscribers = new Map(); // job_id -> Set<res>

export async function appendEvent({ job_id, seq, event_type, event_subtype = null, payload }) {
  const payloadJson = typeof payload === 'string' ? payload : JSON.stringify(payload);
  // ON CONFLICT swallows dup-seq on retry — matches worker/index.js stream
  // parser which can re-run a failed BullMQ job and re-emit the same seq.
  const { rows: inserted } = await pool.query(
    `INSERT INTO agent_job_events (job_id, seq, event_type, event_subtype, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (job_id, seq) DO NOTHING
     RETURNING created_at`,
    [job_id, seq, event_type, event_subtype, payloadJson]
  );
  if (inserted.length === 0) return null;
  const row = {
    job_id, seq, event_type, event_subtype,
    payload_json: payloadJson,
    created_at: inserted[0].created_at.toISOString()
  };
  broadcastToSubscribers(job_id, row);
  return row;
}

export async function listEvents(job_id, { after = -1, limit = 10000 } = {}) {
  const { rows } = await pool.query(
    `SELECT seq, event_type, event_subtype,
            payload::text AS payload_json, created_at
       FROM agent_job_events
      WHERE job_id = $1 AND seq > $2
      ORDER BY seq ASC
      LIMIT $3`,
    [String(job_id), after, limit]
  );
  return rows.map(r => ({
    ...r,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at
  }));
}

// ---------------------------------------------------------------------------
// SSE fan-out — per-job subscribers for tail-follow
// ---------------------------------------------------------------------------

export function subscribe(job_id, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(':\n\n');
  let set = subscribers.get(job_id);
  if (!set) { set = new Set(); subscribers.set(job_id, set); }
  set.add(res);
  const hb = setInterval(() => res.write(':\n\n'), 30000);
  res.on('close', () => {
    clearInterval(hb);
    const s = subscribers.get(job_id);
    if (s) { s.delete(res); if (s.size === 0) subscribers.delete(job_id); }
  });
}

function broadcastToSubscribers(job_id, row) {
  const set = subscribers.get(job_id);
  if (!set || set.size === 0) return;
  const payload = `event: job_event\ndata: ${JSON.stringify(row)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch { /* client gone, cleanup on close */ }
  }
}

// Signal terminal state to live subscribers so the dashboard stops polling.
export function broadcastDone(job_id, meta = {}) {
  const set = subscribers.get(job_id);
  if (!set || set.size === 0) return;
  const payload = `event: job_done\ndata: ${JSON.stringify(meta)}\n\n`;
  for (const res of set) {
    try { res.write(payload); res.end(); } catch { /* ignore */ }
  }
  subscribers.delete(job_id);
}

export function subscriberCount(job_id) {
  return subscribers.get(job_id)?.size || 0;
}
