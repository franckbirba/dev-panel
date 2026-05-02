// src/worker/handlers/pr-scanner.js
// Scheduled poller: lists managed projects, hits GitHub per repo, dispatches
// one merge-coordinator workflow per open PR. Idempotence handled by
// hasActiveInstance + the unique partial index on workflow_instances.
import { Octokit } from '@octokit/rest';
import { listProjects } from '../../server/db.js';
import { enqueueWorkflowStart } from '../dispatch.js';
import {
  hasActiveInstance,
  syntheticWorkItemId,
  extractPlaneRef
} from '../../server/webhooks-github.js';

export async function handlePrScanner(_jobData = {}) {
  const summary = {
    projects_scanned: 0,
    prs_seen: 0,
    dispatched: 0,
    skipped_active: 0,
    errors: []
  };

  const projects = listProjects().filter(
    p => p.github_owner && p.github_repo
  );

  if (projects.length === 0) return summary;

  return summary; // expanded in Task 4
}
