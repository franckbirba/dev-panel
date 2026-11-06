// src/worker/handlers/shelly-digest.js
//
// Digest: read the same data /api/today exposes, format it as a
// short Telegram message, push it via notifyJob (no claude -p, no tokens).
// Triggered by the `shelly:morning-digest` cron at 07:00 Europe/Paris
// or the `shelly:evening-digest` cron at 19:00 Europe/Paris.

import { getMasterDatabase } from '../../server/db.js';
import { getQueue, QUEUES } from '../../server/bullmq.js';
import { notifyJob } from '../../server/alerts.js';

function ageMin(ms, now = Date.now()) { return Math.max(0, Math.round((now - ms) / 60000)); }

export async function handleShellyDigest(jobData) {
  const { job_id, digest_type = 'morning' } = jobData;
  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;

  const db = getMasterDatabase();
  
  // For evening digest, we want to show what happened TODAY (since 07:00)
  // For morning digest, we want to show what happened YESTERDAY (24h ago)
  const periodStart = digest_type === 'evening' ? new Date().setHours(7, 0, 0, 0) : dayAgo;
  
  const insts = db.prepare(
    `SELECT status, last_event_at, started_at, work_item_id, workflow_name, current_step
       FROM workflow_instances
      WHERE last_event_at >= ?
      ORDER BY last_event_at DESC`
  ).all(periodStart);

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

  // Determine if this is morning or evening digest
  const isEvening = digest_type === 'evening';

  let lines = [];
  let title = '';
  let workItemId = '';
  
  if (isEvening) {
    // Evening digest format
    workItemId = 'evening';
    
    // Fetch PRs merged today
    let mergedPRsCount = ships; // Using ships count as proxy for merged PRs
    
    // Fetch items that were blocked but are now progressing
    let unblockedCount = 0;
    try {
      const blockedThenProgressing = db.prepare(
        `SELECT COUNT(*) AS n FROM workflow_instances 
         WHERE status IN ('running', 'done', 'awaiting_approval') 
         AND last_event_at >= ?`
      ).get(periodStart).n;
      
      unblockedCount = blockedThenProgressing;
    } catch (err) {
      console.warn('[Digest] Failed to count unblocked items:', err.message);
    }
    
    // Fetch fleet status
    let fleetStatus = '';
    try {
      const runningCount = db.prepare(
        `SELECT COUNT(*) AS n FROM workflow_instances WHERE status = 'running'`
      ).get().n;
      
      const blockedCount = db.prepare(
        `SELECT COUNT(*) AS n FROM workflow_instances WHERE status = 'blocked'`
      ).get().n;
      
      const awaitingCount = db.prepare(
        `SELECT COUNT(*) AS n FROM workflow_instances WHERE status = 'awaiting_approval'`
      ).get().n;
      
      fleetStatus = `Fleet: ${runningCount} actif${runningCount !== 1 ? 's' : ''}`;
      if (blockedCount > 0) {
        fleetStatus += `, ${blockedCount} bloqué${blockedCount !== 1 ? 's' : ''}`;
      }
      if (awaitingCount > 0) {
        fleetStatus += `, ${awaitingCount} en attente`;
      }
    } catch (err) {
      console.warn('[Digest] Failed to get fleet status:', err.message);
    }
    
    // Fetch reaped instances
    let reapedCount = 0;
    // TODO: Implement proper reaper integration
    
    lines = [
      `_DIGESTE DU SOIR_`,
      mergedPRsCount > 0 ? `PR mergées: ${mergedPRsCount}` : null,
      unblockedCount > 0 ? `Items débloqués: ${unblockedCount}` : null,
      fleetStatus || null,
      reapedCount > 0 ? `${reapedCount} instance${reapedCount !== 1 ? 's' : ''} réinitialisée${reapedCount !== 1 ? 's' : ''}` : null,
      `→ devpanl.dev/dashboard/today`
    ].filter(Boolean);
    
    title = `Soir: ${mergedPRsCount}↑ ${unblockedCount}✓`;
  } else {
    // Morning digest format (unchanged)
    workItemId = 'morning';
    lines = [
      `Hier ${ships} livré · ${failed24h} échec · ${exhausted} épuisé`,
      `En cours: ${running} workflow${running === 1 ? '' : 's'}`,
      awaiting ? `À valider: ${awaiting}` : null,
      `→ devpanl.dev/dashboard/today`
    ].filter(Boolean);
    
    title = `${ships}↑ ${failed24h}✗ ${exhausted}∅`;
  }

  const summary = lines.join(' · ').slice(0, 240);
  
  await notifyJob({
    job_id, agent: 'digest',
    work_item_id: workItemId,
    title: title,
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
