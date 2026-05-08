#!/usr/bin/env node
// Recovery script — find local feat/wi-<uuid>-* branches that were committed
// by an agent run but never pushed/PR'd (worktree cleaned up before
// publishWorkItem fixed cross-repo PR creation, see PRs #66/#67/#68), then
// push them and open a PR with title/description fetched from Plane.
//
// Idempotent: skips branches that are already pushed AND already have a PR
// open or merged. Multi-repo: iterate every checkout under <root>/.
//
// Usage:
//   PLANE_API_KEY=... PLANE_BASE_URL=https://plane.devpanl.dev \
//   PLANE_WORKSPACE_SLUG=devpanl GITHUB_TOKEN=... \
//   API_BASE=http://localhost:3030 ADMIN_API_KEY=... \
//   node scripts/recover-orphan-prs.mjs [--root /home/deploy/projects] [--dry-run] [--limit N]
//
// On the agents host the env is already wired via the worker service;
// run as the `deploy` user so the worktrees are accessible:
//   sudo -u deploy -E node /home/deploy/projects/dev-panel/scripts/recover-orphan-prs.mjs --dry-run

import { execSync } from 'child_process';
import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ROOT = opt('root', '/home/deploy/projects');
const DRY_RUN = flag('dry-run');
const LIMIT = parseInt(opt('limit', '50'), 10);

const PLANE_BASE = (process.env.PLANE_BASE_URL || 'https://plane.devpanl.dev').replace(/\/$/, '');
const PLANE_SLUG = process.env.PLANE_WORKSPACE_SLUG || 'devpanl';
const PLANE_KEY = process.env.PLANE_API_KEY;
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const API_BASE = process.env.API_BASE;
const ADMIN_KEY = process.env.ADMIN_API_KEY;

if (!PLANE_KEY) die('PLANE_API_KEY required');
if (!GH_TOKEN) die('GITHUB_TOKEN required');
if (!API_BASE || !ADMIN_KEY) die('API_BASE + ADMIN_API_KEY required (used to discover repos and resolve project_id → owner/repo)');

const UUID_HEAD_RE = /^feat\/wi-([0-9a-f]{8,12})-/i;

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function git(cwd, args, opts = {}) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function gh(args, opts = {}) {
  const env = { ...process.env, GH_TOKEN };
  return execSync(`gh ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, ...opts }).trim();
}

async function fetchManagedProjects() {
  const r = await fetch(`${API_BASE.replace(/\/$/, '')}/api/admin/projects`, {
    headers: { 'X-Admin-Key': ADMIN_KEY }
  });
  if (!r.ok) die(`/api/admin/projects → ${r.status}`);
  const body = await r.json();
  return body?.projects || [];
}

async function resolveWorkItem(uuid12, plane_project_id) {
  // The branch name only carries the first 8-12 hex chars of the UUID — Plane
  // needs the full UUID. So: list issues for the project, find the one whose
  // id starts with our prefix.
  const url = `${PLANE_BASE}/api/v1/workspaces/${PLANE_SLUG}/projects/${plane_project_id}/issues/?per_page=200`;
  const r = await fetch(url, { headers: { 'X-API-Key': PLANE_KEY } });
  if (!r.ok) return null;
  const body = await r.json();
  const list = body?.results || body || [];
  const lower = uuid12.toLowerCase();
  const wi = list.find(i => String(i.id || '').toLowerCase().startsWith(lower));
  if (!wi) return null;
  // Strip HTML to plain text for the PR body.
  const desc = (wi.description_html || '')
    .replace(/<\/?(p|div|h[1-6]|li|br)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n').trim();
  return { id: wi.id, sequence_id: wi.sequence_id, title: wi.name, description: desc };
}

function listOrphanBranches(repoPath) {
  // Branches matching feat/wi-<uuid>-* that are ahead of origin/main and
  // not yet on origin (or whose origin tip lags the local tip).
  let raw;
  try {
    raw = git(repoPath, 'branch --list "feat/wi-*"');
  } catch { return []; }
  return raw
    .split('\n').map(l => l.replace(/^[*+ ]+/, '').trim()).filter(Boolean)
    .filter(b => UUID_HEAD_RE.test(b));
}

function commitsAhead(repoPath, branch, base = 'origin/main') {
  try {
    const out = git(repoPath, `log --oneline ${base}..${branch}`);
    return out ? out.split('\n').length : 0;
  } catch { return 0; }
}

function remoteHasBranch(repoPath, branch) {
  try {
    git(repoPath, `rev-parse --verify --quiet refs/remotes/origin/${branch}`);
    return true;
  } catch { return false; }
}

function existingPrUrl(repoSpec, branch) {
  try {
    const out = gh(`pr list --repo ${repoSpec} --head ${branch} --state all --json url,state --jq '.[0]'`);
    if (!out) return null;
    return JSON.parse(out);
  } catch { return null; }
}

function pushBranch(repoPath, branch) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would: git push -u origin ${branch}`);
    return;
  }
  git(repoPath, `push -u origin ${branch}`);
}

function createPr(repoSpec, repoPath, branch, title, body) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would: gh pr create --repo ${repoSpec} --base main --head ${branch} --title ${JSON.stringify(title.slice(0, 80))}`);
    return null;
  }
  const safeTitle = JSON.stringify(String(title).slice(0, 100).replace(/\n/g, ' '));
  const safeBody = JSON.stringify(String(body));
  return gh(`pr create --repo ${repoSpec} --base main --head ${branch} --title ${safeTitle} --body ${safeBody}`,
    { cwd: repoPath });
}

(async function main() {
  const projects = await fetchManagedProjects();
  if (!projects.length) die('No managed projects returned by /api/admin/projects');

  console.log(`Recovery scan: ${projects.length} managed project(s). DRY_RUN=${DRY_RUN}.\n`);

  const summary = {
    scanned: 0, pushed: 0, prs_created: 0, skipped_no_diff: 0,
    skipped_already_pr: 0, errors: []
  };

  for (const p of projects) {
    if (!p.local_path || !p.github_owner || !p.github_repo) {
      console.log(`-- ${p.name}: skipping (no local_path or github_owner/repo) --\n`);
      continue;
    }
    const repoPath = p.local_path;
    const repoSpec = `${p.github_owner}/${p.github_repo}`;
    if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
      console.log(`-- ${p.name}: skipping (local_path ${repoPath} not on disk) --\n`);
      continue;
    }
    console.log(`== ${p.name} (${repoSpec}) at ${repoPath} ==`);

    // Refresh remote refs so our remoteHasBranch / origin/main checks are sane.
    try { git(repoPath, 'fetch origin --prune', { stdio: 'pipe' }); }
    catch (e) { console.warn(`   fetch failed (continuing): ${e.message.slice(0, 200)}`); }

    const branches = listOrphanBranches(repoPath);
    if (!branches.length) {
      console.log('   no feat/wi-* branches found.\n');
      continue;
    }

    for (const branch of branches.slice(0, LIMIT)) {
      summary.scanned++;
      const m = branch.match(UUID_HEAD_RE);
      if (!m) continue;
      const prefix = m[1];
      console.log(`\n   • ${branch}`);

      const ahead = commitsAhead(repoPath, branch);
      if (ahead === 0) {
        console.log(`     no commits ahead of origin/main — skip`);
        summary.skipped_no_diff++;
        continue;
      }
      console.log(`     ${ahead} commit(s) ahead of origin/main`);

      const existing = existingPrUrl(repoSpec, branch);
      if (existing && existing.url) {
        console.log(`     PR already exists: ${existing.url} (${existing.state}) — skip`);
        summary.skipped_already_pr++;
        continue;
      }

      let wi = null;
      try {
        wi = await resolveWorkItem(prefix, p.plane_project_id);
      } catch (e) {
        console.warn(`     plane lookup failed: ${e.message}`);
      }
      const title = wi?.title || `Recovered orphan branch ${branch}`;
      const seq = wi?.sequence_id ? ` (${p.name.toUpperCase()}-${wi.sequence_id})` : '';
      const body = [
        `Recovered from a worker run that committed locally but never pushed.`,
        wi ? `\nWork item${seq}: \`${wi.id}\`` : `\nLocal branch: \`${branch}\``,
        wi?.description ? `\n### Original description\n\n${wi.description}` : '',
        `\n_Auto-recovered by scripts/recover-orphan-prs.mjs._`
      ].filter(Boolean).join('\n');

      try {
        if (!remoteHasBranch(repoPath, branch)) {
          pushBranch(repoPath, branch);
          summary.pushed++;
          console.log(`     pushed`);
        } else {
          // Local is ahead even though branch exists on origin → fast-forward push.
          pushBranch(repoPath, branch);
          summary.pushed++;
          console.log(`     pushed (remote already had it, force-with-lease unnecessary in this script — re-pushing)`);
        }
        const url = createPr(repoSpec, repoPath, branch, title, body);
        if (url) {
          summary.prs_created++;
          console.log(`     PR: ${url}`);
        }
      } catch (e) {
        const msg = (e.stderr?.toString() || e.message || '').slice(0, 400);
        console.warn(`     ERROR: ${msg}`);
        summary.errors.push({ branch, repoSpec, error: msg });
      }
    }
    console.log('');
  }

  console.log('======= RECOVERY SUMMARY =======');
  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors.length) process.exit(2);
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
