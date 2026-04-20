// src/worker/handlers/shelly-digest.js
//
// Morning digest: read the same data /api/today exposes, format it as a
// short Telegram message, push it via notifyJob (no claude -p, no tokens).
// Triggered by the `shelly:morning-digest` cron at 07:00 Europe/Paris.

import { getMasterDatabase } from '../../server/db.js';
import { getQueue, QUEUES } from '../../server/bullmq.js';
import { notifyJob } from '../../server/alerts.js';

function ageMin(ms, now = Date.now()) { return Math.max(0, Math.round((now - ms) / 60000)); }

export async function handleShellyDigest(jobData) {
  const { job_id } = jobData;
  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;

  const db = getMasterDatabase();
  const insts = db.prepare(
    `SELECT status, last_event_at, started_at, work_item_id, workflow_name, current_step
       FROM workflow_instances
      WHERE last_event_at >= ?
      ORDER BY last_event_at DESC`
  ).all(dayAgo);

  const ships     = insts.filter(i => i.status === 'done').length;
  const exhausted = insts.filter(i => i.status === 'exhausted').length;
  const awaiting  = insts.filter(i => i.status === 'awaiting_approval').length;
  const running   = db.prepare(
    `SELECT COUNT(*) AS n FROM workflow_instances WHERE status IN ('running','awaiting_approval')`
  ).get().n;

  let failed24h = 0;
  try {
    const queue = getQueue(QUEUES.agents);
    const failed = await queue.getJobs(['failed'], 0, 50);
    failed24h = failed.filter(j => (j.finishedOn || j.timestamp || 0) >= dayAgo).length;
  } catch { /* queue cold */ }

  const lines = [
    `Hier ${ships} livré · ${failed24h} échec · ${exhausted} épuisé`,
    `En cours: ${running} workflow${running === 1 ? '' : 's'}`,
    awaiting ? `À valider: ${awaiting}` : null,
    `→ devpanl.dev/dashboard/today`
  ].filter(Boolean);

  const summary = lines.join(' · ').slice(0, 240);

  await notifyJob({
    job_id, agent: 'digest',
    work_item_id: 'morning',
    title: `${ships}↑ ${failed24h}✗ ${exhausted}∅`,
    status: 'done',
    extra: summary
  });

  return {
    status: 'done',
    summary,
    artifacts: {
      ships_24h: ships, failed_24h: failed24h, exhausted_24h: exhausted,
      awaiting_count: awaiting, running_count: running
    }
  };
}
