// src/worker/handlers/pr-scanner.js
// Scheduled poller: lists managed projects, hits GitHub per repo, dispatches
// one merge-coordinator workflow per open PR. Idempotence handled by
// hasActiveInstance + the unique partial index on workflow_instances.
//
// Note: the master `projects` table lives in the API container's SQLite on
// services VPS. The worker runs on a different host (agents node) with its
// own stale local SQLite, so we MUST fetch the project list over HTTP from
// the API instead of using the local listProjects() — they don't share data.
import { Octokit } from 'octokit';
import { enqueueWorkflowStart } from '../dispatch.js';
import {
  hasActiveInstance,
  syntheticWorkItemId,
  extractPlaneRef
} from '../../server/webhooks-github.js';

function buildOctokit() {
  if (!process.env.GITHUB_TOKEN) {
    console.warn('[pr-scanner] GITHUB_TOKEN not set — anonymous mode, private repos will 404');
  }
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
}

function apiBaseUrl() {
  // WORKER_EVENTS_URL is "<base>/api/admin/events/publish" — strip the path
  // to recover the base. Falls back to localhost for dev.
  const url = process.env.WORKER_EVENTS_URL || 'http://localhost:3030/api/admin/events/publish';
  return url.replace(/\/api\/admin\/events\/publish\/?$/, '');
}

async function fetchProjects() {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    throw new Error('ADMIN_API_KEY not set — cannot fetch projects from API');
  }
  // Use /api/admin/projects (M2M router, no SSO) rather than /api/projects/summary
  // (SPA router, gated by traefik-forward-auth → returns the Google login HTML).
  const url = `${apiBaseUrl()}/api/admin/projects`;
  const r = await fetch(url, { headers: { 'X-Admin-Key': adminKey } });
  if (!r.ok) {
    throw new Error(`GET /api/admin/projects → ${r.status}`);
  }
  const body = await r.json();
  return body.projects || [];
}

export async function handlePrScanner(_jobData = {}) {
  const summary = {
    projects_scanned: 0,
    prs_seen: 0,
    dispatched: 0,
    skipped_active: 0,
    errors: []
  };

  let projects;
  try {
    projects = (await fetchProjects()).filter(
      p => p.github_owner && p.github_repo
    );
  } catch (err) {
    console.error(`[pr-scanner] fetch projects failed: ${err.message}`);
    summary.errors.push({ scope: 'projects', error: err.message });
    return summary;
  }

  if (projects.length === 0) return summary;

  const octokit = buildOctokit();

  for (const project of projects) {
    const repo = `${project.github_owner}/${project.github_repo}`;
    summary.projects_scanned += 1;

    let prs;
    try {
      prs = await octokit.paginate(octokit.rest.pulls.list, {
        owner: project.github_owner,
        repo: project.github_repo,
        state: 'open',
        per_page: 100
      });
    } catch (err) {
      console.error(`[pr-scanner] octokit list failed for ${repo}: ${err.message}`);
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
        plane: {
          work_item_id: synthetic,
          // DEVPA-180: pass plane_project_id so the dispatcher resolves
          // local_path → context.project_root and the worktree lands in
          // the right repo checkout. Same fix as webhooks-github.js.
          ...(project.plane_project_id
            ? { project_id: project.plane_project_id }
            : {})
        },
        work_item: {
          title: pr.title || `PR #${pr.number}`,
          description: pr.body || ''
        },
        context: {
          // Top-level `branch` so prepareWorktree checks out the PR's head
          // branch (merge-coordinator rebases there). Same shape as the
          // webhook path.
          branch: pr.head?.ref,
          github: {
            repo,
            pr_number: pr.number,
            head_sha: pr.head?.sha,
            branch: pr.head?.ref,
            base_ref: pr.base?.ref || 'main',
            head_ref_origin: pr.head?.repo?.full_name || repo,
            is_fork: pr.head?.repo?.full_name && pr.head.repo.full_name !== repo,
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
        console.error(`[pr-scanner] dispatch failed for ${repo}#${pr.number}: ${result.error}`);
        summary.errors.push({ repo, pr: pr.number, error: result.error });
      }
    }
  }

  return summary;
}
