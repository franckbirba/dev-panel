// Persistence + fan-out for agent job events captured from claude -p stream-json.
// See src/worker/stream-parser.js for the event shape.

import { getMasterDatabase } from './db.js';

// Per-job SSE subscriber pools. Live tail-follow uses these — see
// GET /api/admin/jobs/:id/events?stream=1 in routes.js.
const subscribers = new Map(); // job_id -> Set<res>

export function appendEvent({ job_id, seq, event_type, event_subtype = null, payload }) {
  const db = getMasterDatabase();
  const payloadJson = typeof payload === 'string' ? payload : JSON.stringify(payload);
  try {
    db.prepare(
      `INSERT INTO agent_job_events (job_id, seq, event_type, event_subtype, payload)
       VALUES (?, ?, ?, ?, ?)`
    ).run(job_id, seq, event_type, event_subtype, payloadJson);
  } catch (err) {
    // UNIQUE(job_id, seq) collision on retry — swallow; we don't duplicate.
    if (!/UNIQUE/i.test(err.message)) throw err;
    return null;
  }
  const row = { job_id, seq, event_type, event_subtype, payload_json: payloadJson, created_at: new Date().toISOString() };
  broadcastToSubscribers(job_id, row);
  return row;
}

export function listEvents(job_id, { after = -1, limit = 10000 } = {}) {
  const db = getMasterDatabase();
  const rows = db.prepare(
    `SELECT seq, event_type, event_subtype, payload AS payload_json, created_at
       FROM agent_job_events
      WHERE job_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?`
  ).all(String(job_id), after, limit);
  return rows;
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
