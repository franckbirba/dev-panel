// Cross-project signal aggregator. Joins:
//   - deploy_events       (master db) → deploy_failed/succeeded
//   - captures            (master db) → capture_new/triaging
//   - workflow_instances  (master db) → workflow_exhausted/in_progress/done
//   - failed BullMQ jobs  (Redis)     → job_failed
// Each row is annotated with the subject's priority lane (if set).

import { getMasterDatabase } from './db.js';
import { getQueue, QUEUES } from './bullmq.js';

const URGENCY = {
  deploy_failed:        'needs_attention',
  deploy_succeeded:     'fyi',
  bootstrap_failed:     'needs_attention',
  bootstrap_succeeded:  'fyi',
  capture_new:          'needs_attention',
  capture_triaging:     'in_flight',
  workflow_exhausted:   'needs_attention',
  workflow_in_progress: 'in_flight',
  workflow_done:        'fyi',
  job_failed:           'needs_attention'
};

export async function buildSignalsFeed({
  project_id = null, priority = null, needs_me_only = false, since_min = 1440
} = {}) {
  const db = getMasterDatabase();
  const sinceTs = Date.now() - since_min * 60_000;
  const sinceIso = new Date(sinceTs).toISOString();

  const out = [];

  // --- deploy_events ---
  const deployRows = db.prepare(`
    SELECT de.*, p.name AS project_name
      FROM deploy_events de
      JOIN projects p ON p.id = de.project_id
     WHERE de.created_at >= ?
       ${project_id ? 'AND de.project_id = ?' : ''}
  `).all(...(project_id ? [sinceIso, project_id] : [sinceIso]));
  for (const r of deployRows) {
    const signal_type = `deploy_${r.status === 'failed' ? 'failed' : r.status === 'succeeded' ? 'succeeded' : null}`;
    if (!signal_type || signal_type.endsWith('null')) continue;
    out.push({
      subject_type: 'deploy',
      subject_id: r.sha || String(r.id),
      project_id: r.project_id,
      project_name: r.project_name,
      signal_type,
      urgency: URGENCY[signal_type],
      title: r.failed_reason || `${r.ref || 'deploy'} ${r.status}`,
      created_at: r.created_at,
      raw: { sha: r.sha, log_url: r.log_url }
    });
  }

  // --- captures ---
  const captureRows = db.prepare(`
    SELECT c.*, p.name AS project_name,
           (SELECT role FROM capture_messages WHERE capture_id = c.id
              ORDER BY created_at DESC LIMIT 1) AS last_role
      FROM captures c
      JOIN projects p ON p.id = c.project_id
     WHERE c.status IN ('new', 'triaging')
       AND c.created_at >= ?
       ${project_id ? 'AND c.project_id = ?' : ''}
  `).all(...(project_id ? [sinceIso, project_id] : [sinceIso]));
  for (const r of captureRows) {
    const signal_type = r.status === 'new' ? 'capture_new' : 'capture_triaging';
    out.push({
      subject_type: 'capture',
      subject_id: r.id,
      project_id: r.project_id,
      project_name: r.project_name,
      signal_type,
      urgency: URGENCY[signal_type],
      title: r.content.slice(0, 120),
      created_at: r.created_at,
      raw: { last_role: r.last_role }
    });
  }

  // --- workflow_instances ---
  // workflow_instances doesn't carry project_id in current schema; for Stage 1 we
  // surface workflows for the requested project only, when project_id is provided.
  if (project_id) {
    try {
      const wiRows = db.prepare(`
        SELECT wi.*, ? AS project_id_fk,
               (SELECT name FROM projects WHERE id = ?) AS project_name
          FROM workflow_instances wi
         WHERE wi.last_event_at >= ?
      `).all(project_id, project_id, sinceTs);
      for (const r of wiRows) {
        let signal_type = null;
        if (r.status === 'awaiting_approval') signal_type = 'workflow_exhausted';
        else if (r.status === 'running')      signal_type = 'workflow_in_progress';
        else if (r.status === 'done')         signal_type = 'workflow_done';
        if (!signal_type) continue;
        out.push({
          subject_type: 'work_item',
          subject_id: r.work_item_id,
          project_id: r.project_id_fk,
          project_name: r.project_name,
          signal_type,
          urgency: URGENCY[signal_type],
          title: `${r.workflow_name} → ${r.current_step}`,
          created_at: new Date(r.last_event_at).toISOString(),
          raw: { revision: r.revision }
        });
      }
    } catch (e) {
      // workflow_instances table may not exist in test DBs — degrade silently.
    }
  }

  // --- BullMQ failed jobs ---
  try {
    const queue = getQueue(QUEUES.agent);
    const failed = await queue.getJobs(['failed'], 0, 50);
    for (const j of failed) {
      const ts = j.finishedOn || j.processedOn || Date.now();
      if (ts < sinceTs) continue;
      out.push({
        subject_type: 'job',
        subject_id: String(j.id),
        project_id: j.data?.project_id || null,
        project_name: j.data?.project_name || null,
        signal_type: 'job_failed',
        urgency: URGENCY.job_failed,
        title: j.failedReason || 'job failed',
        created_at: new Date(ts).toISOString(),
        raw: { agent: j.data?.agent, attempts: j.attemptsMade }
      });
    }
  } catch (e) {
    // Redis down or queue not initialised — degrade silently rather than 500 the feed.
  }

  // --- annotate priority from subjects ---
  if (out.length > 0) {
    const subjMap = new Map();
    const placeholders = out.map(() => '(?, ?)').join(',');
    const params = out.flatMap(r => [r.subject_type, r.subject_id]);
    const rows = db.prepare(`
      SELECT subject_type, subject_id, priority FROM subjects
       WHERE (subject_type, subject_id) IN (VALUES ${placeholders})
    `).all(...params);
    for (const s of rows) subjMap.set(`${s.subject_type}/${s.subject_id}`, s.priority);
    for (const r of out) r.priority = subjMap.get(`${r.subject_type}/${r.subject_id}`) ?? null;
  }

  // --- filters ---
  let filtered = out;
  if (priority) filtered = filtered.filter(r => r.priority === priority);
  if (needs_me_only) filtered = filtered.filter(r => r.urgency === 'needs_attention');

  // --- sort: needs_attention first, then in_flight, then fyi; within each, newest first.
  const order = { needs_attention: 0, in_flight: 1, fyi: 2 };
  filtered.sort((a, b) => {
    const u = order[a.urgency] - order[b.urgency];
    if (u !== 0) return u;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  return filtered;
}
