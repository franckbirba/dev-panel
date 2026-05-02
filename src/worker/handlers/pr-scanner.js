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

function buildOctokit() {
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
}

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

  const octokit = buildOctokit();

  for (const project of projects) {
    const repo = `${project.github_owner}/${project.github_repo}`;
    summary.projects_scanned += 1;

    let prs;
    try {
      const { data } = await octokit.pulls.list({
        owner: project.github_owner,
        repo: project.github_repo,
        state: 'open',
        per_page: 50
      });
      prs = data;
    } catch (err) {
      summary.errors.push({ repo, error: err.message });
      continue;
    }

    for (const pr of prs) {
      summary.prs_seen += 1;
      const synthetic = syntheticWorkItemId(repo, pr.number);

      if (await hasActiveInstance(repo, pr.number)) {
        summary.skipped_active += 1;
        continue;
      }

      const planeRef = extractPlaneRef(pr.head?.ref, pr.title);

      const result = await enqueueWorkflowStart({
        workflow: 'merge-coordinator',
        plane: { work_item_id: synthetic },
        work_item: {
          title: pr.title || `PR #${pr.number}`,
          description: pr.body || ''
        },
        context: {
          github: {
            repo,
            pr_number: pr.number,
            head_sha: pr.head?.sha,
            branch: pr.head?.ref,
            plane_ref: planeRef
          }
        }
      });

      if (result.ok) {
        summary.dispatched += 1;
        console.log(`[pr-scanner] dispatched merge-coordinator for ${repo}#${pr.number} instance=${result.instance_id}`);
      } else if (result.error === 'already_running') {
        summary.skipped_active += 1;
      } else {
        summary.errors.push({ repo, pr: pr.number, error: result.error });
      }
    }
  }

  return summary;
}
