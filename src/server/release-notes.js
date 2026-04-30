// Build and broadcast a release note when a pull request gets merged.
// Triggered by webhooks-github.js on pull_request.closed + merged=true.

import { pool } from './pg.js';
import { listActive } from './dev-bots.js';
import { extractPlaneRef } from './webhooks-github.js';

export async function recordBroadcast(syntheticId) {
  const { rows } = await pool.query(
    `INSERT INTO release_broadcasts (synthetic_id)
     VALUES ($1)
     ON CONFLICT (synthetic_id) DO NOTHING
     RETURNING synthetic_id`,
    [syntheticId]
  );
  return { inserted: rows.length > 0 };
}

const COMMIT_CAP = 8;

export function buildReleaseNote({ pr, repo, commits, cycle }) {
  const author = pr.user?.login || 'unknown';
  const filesChanged = pr.changed_files ?? 0;
  const additions = pr.additions ?? 0;
  const deletions = pr.deletions ?? 0;

  const lines = [
    `Merged — ${repo} #${pr.number}: ${pr.title || '(no title)'}`,
    `by @${author}  ·  ${filesChanged} files, +${additions}/-${deletions}`,
    ''
  ];

  if (commits === null || commits === undefined) {
    lines.push('(commits unavailable)');
  } else {
    const shown = commits.slice(0, COMMIT_CAP);
    for (const c of shown) {
      const subject = (c.commit?.message || '').split('\n')[0];
      const sha7 = String(c.sha || '').slice(0, 7);
      lines.push(`• ${sha7} ${subject}`);
    }
    if (commits.length > COMMIT_CAP) {
      lines.push(`(+${commits.length - COMMIT_CAP} more)`);
    }
  }

  if (cycle) {
    lines.push('');
    lines.push(`Cycle: ${cycle.name} — ${cycle.url}`);
  }

  return lines.join('\n');
}

function planeConfig() {
  const base = (process.env.PLANE_BASE_URL || 'https://plane.devpanl.dev').replace(/\/$/, '');
  const slug = process.env.PLANE_WORKSPACE_SLUG || 'devpanl';
  const key = process.env.PLANE_API_TOKEN || process.env.PLANE_API_KEY || '';
  if (!key) return null;
  return { base, slug, key };
}

async function planeGet(cfg, path) {
  const r = await fetch(`${cfg.base}/api/v1/workspaces/${cfg.slug}${path}`, {
    headers: { 'X-API-Key': cfg.key },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.results || data || [];
}

export async function resolveCycle(planeRef) {
  if (!planeRef) return null;
  const cfg = planeConfig();
  if (!cfg) return null;

  try {
    let projectId = null;

    if (planeRef.type === 'sequence') {
      const projects = await planeGet(cfg, '/projects/');
      if (!projects) return null;
      const match = projects.find(p => p.identifier === planeRef.project);
      if (!match) return null;
      projectId = match.id;
    } else if (planeRef.type === 'uuid') {
      const projects = await planeGet(cfg, '/projects/');
      if (!projects) return null;
      for (const p of projects) {
        const r = await fetch(
          `${cfg.base}/api/v1/workspaces/${cfg.slug}/projects/${p.id}/issues/${planeRef.value}/`,
          { headers: { 'X-API-Key': cfg.key }, signal: AbortSignal.timeout(5000) }
        ).catch(() => null);
        if (r && r.ok) { projectId = p.id; break; }
      }
      if (!projectId) return null;
    } else {
      return null;
    }

    const cycles = await planeGet(cfg, `/projects/${projectId}/cycles/active/`);
    if (!cycles || cycles.length === 0) return null;

    const cycle = cycles[0];
    return {
      name: cycle.name,
      url: `${cfg.base}/${cfg.slug}/projects/${projectId}/cycles/${cycle.id}/`
    };
  } catch (err) {
    console.warn(`[release-notes] resolveCycle failed: ${err.message}`);
    return null;
  }
}

export async function fetchCommits(repo, prNumber) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('[release-notes] GITHUB_TOKEN missing, cannot fetch commits');
    return null;
  }
  try {
    const r = await fetch(
      `https://api.github.com/repos/${repo}/pulls/${prNumber}/commits?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json'
        }
      }
    );
    if (!r.ok) {
      console.warn(`[release-notes] commits HTTP ${r.status} for ${repo}#${prNumber}`);
      return null;
    }
    return await r.json();
  } catch (err) {
    console.warn(`[release-notes] commits fetch failed for ${repo}#${prNumber}: ${err.message}`);
    return null;
  }
}

async function sendTelegram(token, chatId, text) {
  if (!chatId) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!r.ok) console.warn(`[release-notes] sendMessage ${r.status} for chat=${chatId}`);
  } catch (err) {
    console.warn(`[release-notes] sendMessage failed for chat=${chatId}: ${err.message}`);
  }
}

export async function fanOut(text) {
  const bots = await listActive();
  if (!bots || bots.length === 0) {
    console.log('[release-notes] no active bots, skipping fan-out');
    return;
  }
  await Promise.allSettled(bots.map(b =>
    sendTelegram(b.bot_token, b.owner_tg_user_id, text)
  ));
}

export function syntheticMergedId(repo, prNumber) {
  return `github:${repo}#${prNumber}:merged`;
}

export async function broadcastRelease({ repo, pr }) {
  const id = syntheticMergedId(repo, pr.number);
  const { inserted } = await recordBroadcast(id);
  if (!inserted) {
    console.log(`[release-notes] replay skipped for ${id}`);
    return { broadcast: false, reason: 'replay' };
  }

  const branch = pr.head?.ref;
  const planeRef = extractPlaneRef(branch, pr.title);

  const [commits, cycle] = await Promise.all([
    fetchCommits(repo, pr.number),
    resolveCycle(planeRef)
  ]);

  const text = buildReleaseNote({ pr, repo, commits, cycle });
  await fanOut(text);

  return { broadcast: true };
}
