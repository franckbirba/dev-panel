// Build and broadcast a release note when a pull request gets merged.
// Triggered by webhooks-github.js on pull_request.closed + merged=true.

import { pool } from './pg.js';

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
