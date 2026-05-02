// BullMQ handler: clones a freshly-bootstrapped project on the agents host.
// Posts status back via notifyJob so the deploy_events table gets a row
// (see alerts.js + Task 7) and the signal feed surfaces it.

import { spawn } from 'child_process';
import { dirname } from 'path';
import { mkdirSync } from 'fs';
import { notifyJob } from '../../server/alerts.js';

// Rewrite an https://github.com/... clone URL to include a PAT in the
// userinfo so `git clone` works against private repos without credential
// helpers, ssh keys, or interactive prompts. Returns the URL untouched if:
//   - GITHUB_TOKEN is not set
//   - the URL already has a userinfo (someone else already authenticated)
//   - the URL isn't pointed at github.com (preserves SSH-style or other hosts)
//
// Exported so tests can pin the rewriting rules without spawning git.
export function withGithubAuth(url, token = process.env.GITHUB_TOKEN) {
  if (!token) return url;
  if (typeof url !== 'string') return url;
  let parsed;
  try { parsed = new URL(url); } catch { return url; }
  if (parsed.protocol !== 'https:') return url;
  if (parsed.hostname !== 'github.com') return url;
  if (parsed.username || parsed.password) return url;  // already authed
  parsed.username = 'x-access-token';
  parsed.password = token;
  return parsed.toString();
}

export async function handleBootstrapProject(job) {
  const { project_id, github_url, target_path } = job.data;
  const startedAt = Date.now();

  // Ensure parent directory exists (idempotent).
  try { mkdirSync(dirname(target_path), { recursive: true }); }
  catch (e) { /* Best-effort — git clone will fail loudly if mkdir actually mattered. */ }

  // The token-bearing URL is only ever passed to the spawned git process.
  // Every `notifyJob` / log statement uses the original github_url so the
  // PAT never leaks to the deploy_events table, Telegram, or stderr scrape.
  const cloneUrl = withGithubAuth(github_url);

  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['clone', cloneUrl, target_path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    proc.on('exit', async (code) => {
      const duration_ms = Date.now() - startedAt;
      if (code === 0) {
        await notifyJob({
          job_id: String(job.id), agent: 'bootstrap', work_item_id: project_id,
          title: `clone ${github_url}`, status: 'done', duration_ms
        });
        resolve({ ok: true, target_path });
      } else {
        const reason = (stderr.split('\n').find(l => l.startsWith('fatal:')) || stderr.trim().split('\n')[0] || `exit ${code}`).slice(0, 200);
        await notifyJob({
          job_id: String(job.id), agent: 'bootstrap', work_item_id: project_id,
          title: `clone ${github_url}`, status: 'failed', extra: reason, duration_ms
        });
        reject(new Error(reason));
      }
    });
    proc.on('error', async (err) => {
      await notifyJob({
        job_id: String(job.id), agent: 'bootstrap', work_item_id: project_id,
        title: `clone ${github_url}`, status: 'failed', extra: err.message
      });
      reject(err);
    });
  });
}
