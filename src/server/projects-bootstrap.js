// Paste-URL project bootstrap.
//
// One call: probe GitHub → create Plane project → mint DevPanel API key →
// enqueue an async `bootstrap_project` job that clones the repo on the
// agents host. Project is usable in the dashboard immediately; the clone
// completion is surfaced as a signal.

import { createProject, getProjectByName } from './db.js';
import { getQueue, QUEUES } from './bullmq.js';

const GH_HTTPS_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const GH_SSH_RE   = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/;
const GH_SHORT_RE = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/;

export function parseGithubUrl(url) {
  if (typeof url !== 'string') throw new Error('invalid github url');
  const trimmed = url.trim();
  for (const re of [GH_HTTPS_RE, GH_SSH_RE, GH_SHORT_RE]) {
    const m = trimmed.match(re);
    if (m) return { owner: m[1], repo: m[2] };
  }
  throw new Error(`invalid github url: ${url}`);
}

async function probeGithub({ owner, repo }) {
  const token = process.env.GITHUB_TOKEN;
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: token
      ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
      : { Accept: 'application/vnd.github+json' }
  });
  if (r.status === 404) throw new Error(`github: repo ${owner}/${repo} not found or token lacks access`);
  if (!r.ok) throw new Error(`github: ${r.status} ${(await r.json().catch(() => ({}))).message || ''}`);
  return r.json();
}

async function createPlaneProject({ name, description, identifier }) {
  const base = process.env.PLANE_API_BASE;
  const slug = process.env.PLANE_WORKSPACE_SLUG;
  const token = process.env.PLANE_API_TOKEN;
  if (!base || !slug || !token) throw new Error('plane: PLANE_API_BASE / PLANE_WORKSPACE_SLUG / PLANE_API_TOKEN required');
  const r = await fetch(`${base}/api/v1/workspaces/${slug}/projects/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': token },
    body: JSON.stringify({ name, description: description || '', identifier })
  });
  if (!r.ok) throw new Error(`plane: ${r.status} ${(await r.json().catch(() => ({}))).error || ''}`);
  return r.json();
}

function planeIdentifier(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5).toUpperCase() || 'PROJ';
}

export async function bootstrapFromGithub({ github_url }) {
  const { owner, repo } = parseGithubUrl(github_url);

  // Step 1: GitHub probe (no writes yet).
  const ghRepo = await probeGithub({ owner, repo });

  // Step 2: Plane create (no writes to our DB yet).
  let planeProj;
  try {
    planeProj = await createPlaneProject({
      name: ghRepo.name,
      description: ghRepo.description,
      identifier: planeIdentifier(ghRepo.name)
    });
  } catch (e) {
    if (/identifier.*already/i.test(e.message)) {
      planeProj = await createPlaneProject({
        name: ghRepo.name,
        description: ghRepo.description,
        identifier: planeIdentifier(ghRepo.name + '2')
      });
    } else {
      throw e;
    }
  }

  // Step 3: Mint DevPanel project + key.
  const localPath = `${process.env.AGENTS_HOST_PROJECTS_PATH || '/home/deploy/projects'}/${ghRepo.name}`;
  const project = createProject({
    name: ghRepo.name,
    description: ghRepo.description || '',
    github_owner: owner,
    github_repo: repo,
    plane_project_id: planeProj.id,
    plane_workspace_slug: process.env.PLANE_WORKSPACE_SLUG,
    default_branch: ghRepo.default_branch || 'main',
    local_path: localPath
  });
  const fullProject = { ...project, plane_project_id: planeProj.id, local_path: localPath, github_owner: owner };

  // Step 4: Enqueue bootstrap job (best effort — failure surfaces as a signal).
  let bootstrap_job_id = null;
  try {
    const queue = getQueue(QUEUES.agent);
    const job = await queue.add('bootstrap_project', {
      agent: 'bootstrap',
      project_id: project.id,
      github_url,
      target_path: localPath
    }, { attempts: 2, backoff: { type: 'exponential', delay: 30_000 } });
    bootstrap_job_id = job.id;
  } catch (e) {
    console.error('[bootstrap] enqueue failed:', e.message);
  }

  return { project: fullProject, bootstrap_job_id };
}
