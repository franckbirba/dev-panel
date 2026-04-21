// Deploy + bootstrap event log. One table for all infra events;
// `status` distinguishes (started, succeeded, failed, bootstrap_succeeded,
// bootstrap_failed). Drives the "deploy" / "bootstrap" rows in /api/signals.

import { getMasterDatabase } from './db.js';

const VALID_STATUSES = new Set([
  'started', 'succeeded', 'failed',
  'bootstrap_started', 'bootstrap_succeeded', 'bootstrap_failed'
]);

export function recordDeployEvent({
  project_id, status, sha = null, ref = null, log_url = null,
  failed_reason = null, started_at = null, finished_at = null
}) {
  if (!VALID_STATUSES.has(status)) throw new Error(`invalid status: ${status}`);
  const db = getMasterDatabase();
  const info = db.prepare(`
    INSERT INTO deploy_events (project_id, status, sha, ref, log_url, failed_reason, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(project_id, status, sha, ref, log_url, failed_reason, started_at, finished_at);
  return info.lastInsertRowid;
}

export function listRecentDeploys(project_id, limit = 50) {
  const db = getMasterDatabase();
  return db.prepare(`
    SELECT * FROM deploy_events
     WHERE project_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?
  `).all(project_id, limit);
}
