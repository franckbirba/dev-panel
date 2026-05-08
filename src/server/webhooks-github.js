// src/server/webhooks-github.js
// GitHub webhook handler for pull_request events.
// Dispatches merge-coordinator workflow on PR open/reopen/synchronize.
import crypto from 'crypto';
import express from 'express';
import { pool } from './pg.js';
import { getProjectByGithubRepo } from './db.js';

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

// Branch name → Plane work item patterns:
//   feat/wi-<uuid>-slug           (UUID from worker worktree convention)
//   devpa-NNN-slug / zeno-NNN-slug / edms-NNN-slug
const BRANCH_UUID_RE = /^feat\/wi-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i;
const BRANCH_SEQ_RE = /\b(devpa|zeno|edms)-(\d+)\b/i;
const TITLE_SEQ_RE = /\b(DEVPA|ZENO|EDMS)-(\d+)\b/;

const ALLOWED_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'closed']);

// Agent-only gate: dispatch merge-coordinator only on PRs that are recognizably
// from an ephemeral agent worktree, never on human PRs. Two signals — either
// suffices:
//   1. branch matches the worker's `feat/wi-<uuid>-*` convention (only the
//      worker's prepareWorktree creates branches in that shape).
//   2. PR carries the explicit `agent-merge` label.
// Human PRs (Franck, Edwin, Alex) lack both. This kills the "every push fires
// a merge-coordinator that always blocks" cost the webhook used to pay.
const AGENT_BRANCH_RE = /^feat\/wi-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;
const AGENT_MERGE_LABEL = 'agent-merge';

export function isAgentPR(pr) {
  if (!pr) return false;
  if (AGENT_BRANCH_RE.test(pr.head?.ref || '')) return true;
  const labels = Array.isArray(pr.labels) ? pr.labels : [];
  return labels.some(l => (l?.name || '') === AGENT_MERGE_LABEL);
}

export function verifySignature(payload, signature, secret = WEBHOOK_SECRET) {
  if (!secret || !signature) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

export function extractPlaneRef(branch, title) {
  // Try UUID-based branch convention first
  const um = branch?.match(BRANCH_UUID_RE);
  if (um) return { type: 'uuid', value: um[1] };

  // Try sequence-based branch convention
  const bm = branch?.match(BRANCH_SEQ_RE);
  if (bm) return { type: 'sequence', project: bm[1].toUpperCase(), number: parseInt(bm[2], 10) };

  // Try PR title
  const tm = title?.match(TITLE_SEQ_RE);
  if (tm) return { type: 'sequence', project: tm[1].toUpperCase(), number: parseInt(tm[2], 10) };

  return null;
}

export function syntheticWorkItemId(repo, prNumber) {
  return `github:${repo}#${prNumber}`;
}

export async function hasActiveInstance(repo, prNumber) {
  const synthetic = syntheticWorkItemId(repo, prNumber);
  const { rows } = await pool.query(
    `SELECT id FROM workflow_instances
     WHERE workflow_name = 'merge-coordinator'
       AND status IN ('running', 'awaiting_approval')
       AND work_item_id = $1
     LIMIT 1`,
    [synthetic]
  );
  return rows.length > 0;
}

// Allow tests to swap the dispatch function
let _dispatchFn = null;
export function __setDispatchForTests(fn) { _dispatchFn = fn; }

async function getDispatch() {
  if (_dispatchFn) return _dispatchFn;
  const mod = await import('../worker/dispatch.js');
  return mod.enqueueWorkflowStart;
}

export function mountGitHubWebhook(app) {
  app.post('/api/webhooks/github',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req, res) => {
      try {
        const rawBody = req.body;

        // Verify HMAC signature when secret is configured
        if (WEBHOOK_SECRET) {
          const sig = req.headers['x-hub-signature-256'];
          if (!verifySignature(rawBody, sig)) {
            return res.status(401).json({ error: 'invalid signature' });
          }
        }

        // Parse body (raw Buffer → JSON)
        let payload;
        try {
          payload = JSON.parse(
            Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody
          );
        } catch {
          return res.status(400).json({ error: 'invalid JSON' });
        }

        // Filter: only pull_request events
        const event = req.headers['x-github-event'];
        if (event !== 'pull_request') return res.status(204).end();

        // Filter: only opened / reopened / synchronize / closed
        if (!ALLOWED_ACTIONS.has(payload.action)) return res.status(204).end();

        const pr = payload.pull_request;
        if (!pr) return res.status(400).json({ error: 'missing pull_request' });

        const repo = payload.repository?.full_name;
        const prNumber = pr.number;
        const headSha = pr.head?.sha;
        const branch = pr.head?.ref;
        const prTitle = pr.title;

        if (!repo || !prNumber) {
          return res.status(400).json({ error: 'missing repo or pr number' });
        }

        // Closed + merged → release-note broadcast, never dispatch merge-coordinator.
        if (payload.action === 'closed') {
          if (!pr.merged) return res.status(204).end();
          const { broadcastRelease } = await import('./release-notes.js');
          const result = await broadcastRelease({ repo, pr });
          return res.status(result.broadcast ? 202 : 204).end();
        }

        // Agent-PR gate. Human PRs never trigger merge-coordinator — the
        // workflow blocks 100% of the time on them and Franck merges manually
        // anyway. Only fire for recognizable agent worktree branches or PRs
        // explicitly labelled `agent-merge`.
        if (!isAgentPR(pr)) {
          console.log(`[webhook] merge-coordinator skipped for ${repo}#${prNumber}: not an agent PR`);
          return res.status(204).end();
        }

        // Idempotence: skip if merge-coordinator already active for this PR
        const active = await hasActiveInstance(repo, prNumber);
        if (active) {
          console.log(`[webhook] merge-coordinator already active for ${repo}#${prNumber}, skipping`);
          return res.status(204).end();
        }

        // Try to match PR to a Plane work item
        const planeRef = extractPlaneRef(branch, prTitle);

        // Always use synthetic ID for webhook-dispatched merge-coordinators
        // so idempotence works via the unique partial index.
        // The agent resolves the actual Plane work item from planeRef at runtime.
        const workItemId = syntheticWorkItemId(repo, prNumber);

        // Resolve repo → projects row → plane_project_id so the dispatcher's
        // DEVPA-180 lookup can put the right `local_path` on context.
        // Without this, every Zeno/EDMS PR worktree gets created under
        // PROJECT_ROOT (dev-panel) — that's the bug that took out jobs
        // 1581/1605/1607/1609 with "feat/wi-github:E-…" branch errors.
        const [ownerName, repoName] = repo.split('/');
        const project = getProjectByGithubRepo(ownerName, repoName);

        const dispatch = await getDispatch();
        const result = await dispatch({
          workflow: 'merge-coordinator',
          plane: {
            work_item_id: workItemId,
            ...(project?.plane_project_id ? { project_id: project.plane_project_id } : {})
          },
          work_item: {
            title: prTitle || `PR #${prNumber}`,
            description: pr.body || ''
          },
          context: {
            // Top-level `branch` makes prepareWorktree check out the PR's
            // head branch instead of creating a synthetic one off main —
            // required for the merge-coordinator to actually rebase the PR.
            // `head_ref_origin` is set when the PR is from a fork; we pass
            // it so the worker can fetch from the right remote URL.
            branch,
            github: {
              repo,
              pr_number: prNumber,
              head_sha: headSha,
              branch,
              base_ref: pr.base?.ref || 'main',
              head_ref_origin: pr.head?.repo?.full_name || repo,
              is_fork: pr.head?.repo?.full_name && pr.head.repo.full_name !== repo,
              plane_ref: planeRef
            }
          }
        });

        if (!result.ok) {
          if (result.error === 'already_running') {
            console.log(`[webhook] merge-coordinator already running for ${repo}#${prNumber}`);
            return res.status(204).end();
          }
          console.error(`[webhook] dispatch failed for ${repo}#${prNumber}:`, result.error);
          return res.status(500).json({ error: result.error });
        }

        console.log(`[webhook] dispatched merge-coordinator for ${repo}#${prNumber} instance=${result.instance_id}`);
        return res.status(201).json({
          instance_id: result.instance_id,
          job_id: result.job_id
        });

      } catch (err) {
        console.error('[webhook] error:', err);
        return res.status(500).json({ error: 'internal error' });
      }
    }
  );
}
