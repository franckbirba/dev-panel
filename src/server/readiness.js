// src/server/readiness.js
//
// ADR-003 §1/§2 — the repo-ready contract, machine-verifiable from two
// sides. This module implements the services-side half (S1-S3, checked
// directly against the `projects` row — no network) and orchestrates the
// agents-host half (A1-A3) by delegating to the worker's local HTTP check
// (see src/worker/readiness-local.js + the /readiness/:project_id route
// mounted in src/worker/api.js).
//
// Why not SSH from the API for A1-A3: that's the architecture that crashed
// the API before (see ADR-003 §"Alternatives rejetées" — F2). The worker is
// already on the agents host and can stat/exec locally.
//
// Hard rule (ADR-003 §2, explicit): when the worker is unreachable, A1-A3
// MUST render as `warn` with an explicit "agents host non vérifiable"
// detail — never a silent/false `pass`. `ready` is only ever driven down by
// `fail`, never by `warn` — a project with an unreachable worker is
// "unverified", not "not ready" (the dispatch guard in worker/dispatch.js
// is what actually blocks fail-state dispatches; readiness reporting must
// stay honest about degraded visibility rather than pretend green).

const WORKER_READINESS_TIMEOUT_MS = 5000;

/**
 * Pure, network-free. S1: project row exists. S2: plane_project_id set.
 * S3: local_path set. S4: github_owner + github_repo both set.
 * S5 (soft): default_branch set — warn only, not a hard blocker per ADR-003
 * ("default_branch cohérent" is about R1 cross-check, not existence).
 */
export function computeServicesChecks(project) {
  if (!project) {
    return [{ id: 'S1', status: 'fail', detail: 'no projects row for this id' }];
  }

  const checks = [
    { id: 'S1', status: 'pass', detail: 'projects row exists' }
  ];

  checks.push(
    project.plane_project_id
      ? { id: 'S2', status: 'pass', detail: `plane_project_id=${project.plane_project_id}` }
      : { id: 'S2', status: 'fail', detail: 'plane_project_id is not set' }
  );

  checks.push(
    project.local_path
      ? { id: 'S3', status: 'pass', detail: `local_path=${project.local_path}` }
      : { id: 'S3', status: 'fail', detail: 'local_path is not set' }
  );

  checks.push(
    project.github_owner && project.github_repo
      ? { id: 'S4', status: 'pass', detail: `${project.github_owner}/${project.github_repo}` }
      : { id: 'S4', status: 'fail', detail: 'github_owner/github_repo not both set' }
  );

  checks.push(
    project.default_branch
      ? { id: 'S5', status: 'pass', detail: `default_branch=${project.default_branch}` }
      : { id: 'S5', status: 'warn', detail: 'default_branch is not set' }
  );

  return checks;
}

function agentsHostUnverifiableChecks() {
  const detail = 'agents host non vérifiable (worker injoignable)';
  return [
    { id: 'A1', status: 'warn', detail },
    { id: 'A2', status: 'warn', detail },
    { id: 'A3', status: 'warn', detail }
  ];
}

/**
 * Calls the worker's local readiness endpoint for A1-A3. Never throws —
 * any failure mode (missing config, network error, non-200, malformed
 * body) degrades to the explicit warn checks above so the caller never
 * renders a false pass.
 */
async function fetchAgentsHostChecks(project) {
  const workerApiUrl = process.env.WORKER_API_URL;
  if (!workerApiUrl) return agentsHostUnverifiableChecks();

  const url = `${workerApiUrl.replace(/\/$/, '')}/readiness/${encodeURIComponent(project.id)}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(WORKER_READINESS_TIMEOUT_MS) });
  } catch {
    return agentsHostUnverifiableChecks();
  }
  if (!res.ok) return agentsHostUnverifiableChecks();

  let body;
  try {
    body = await res.json();
  } catch {
    return agentsHostUnverifiableChecks();
  }
  if (!body || !Array.isArray(body.checks) || !body.checks.length) {
    return agentsHostUnverifiableChecks();
  }
  return body.checks;
}

/**
 * Full readiness: S1-S3 (local, synchronous logic) + A1-A3 (delegated to
 * the worker, degrading to warn on any unreachability). `ready` is false
 * iff any check — services or agents-host — is `fail`. `warn` never flips
 * `ready` to false (that's the whole point of "unverifiable, not unready").
 */
export async function checkReadiness(project) {
  const serviceChecks = computeServicesChecks(project);

  // No project row at all: S1 already fails: still ask the worker isn't
  // meaningful (nothing to check on disk), skip straight to unverifiable
  // agent checks for a complete, honest response shape.
  const agentChecks = project
    ? await fetchAgentsHostChecks(project)
    : agentsHostUnverifiableChecks();

  const checks = [...serviceChecks, ...agentChecks];
  const ready = checks.every(c => c.status !== 'fail');

  return { ready, checks };
}
