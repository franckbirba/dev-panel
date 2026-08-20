// src/worker/readiness-local.js
//
// ADR-003 §1 — agents-host readiness checks (A1-A3), run locally on the
// worker's filesystem. These MUST run here rather than the API doing SSH —
// SSH-from-the-API is the architecture that crashed the API before
// (ADR-003 "Alternatives rejetées", ref F2). local_path is supplied by the
// caller (services, via query string — see src/server/readiness.js) rather
// than resolved from this host's own SQLite, because storage/projects.db is
// empty on the agents host (DEVPA-180: services is the sole source of truth).
//
// - A1: a real clone exists at local_path (directory + .git present).
// - A2: freshness — last fetch < 48h old (soft: warn, not fail. The worker
//   fetches on every prepareWorktree anyway, per ADR-003 §1).
// - A3: auth hygiene — the origin remote must never carry a token/credential
//   embedded in the URL. This is BLOCKING (fail, not warn) — it's the exact
//   leak pattern constated on Zeno (ghp_... in the remote URL, readable by
//   anyone with fs access to the clone or `git remote -v`).

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const FETCH_FRESHNESS_MS = 48 * 3600 * 1000;

function git(args, cwd) {
  return execSync(`git ${args}`, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

// Matches userinfo (user[:pass]@) or a bare token-shaped credential
// (ghp_/gho_/ghu_/ghs_/ghr_ prefixes used by GitHub PATs) embedded ahead of
// the host in an http(s) remote URL. SSH remotes (git@host:owner/repo.git)
// never carry this — the git@ prefix is the protocol's own convention, not
// a leaked secret, so it's excluded on purpose.
const EMBEDDED_CREDENTIAL_RE = /^https?:\/\/[^/@]+@/i;

function allWarn(detail = 'agents host non vérifiable (worker injoignable)') {
  return [
    { id: 'A1', status: 'warn', detail },
    { id: 'A2', status: 'warn', detail },
    { id: 'A3', status: 'warn', detail }
  ];
}

/**
 * Runs A1-A3 against a single on-disk clone. Never throws — any check that
 * can't be determined degrades to `warn` (A1/A2) with the exception of A3,
 * which is blocking by design (ADR-003: "check bloquant — c'est le leak
 * constaté sur Zeno") but still only fires `fail` when a credential is
 * actually observed; an unreadable remote degrades to `warn` rather than a
 * false fail.
 */
export async function checkLocalReadiness(localPath) {
  if (!localPath) return allWarn('agents host non vérifiable (local_path manquant)');

  if (!existsSync(localPath) || !existsSync(join(localPath, '.git'))) {
    return [
      { id: 'A1', status: 'fail', detail: `no clone at ${localPath}` },
      { id: 'A2', status: 'warn', detail: 'no clone to check fetch freshness on' },
      { id: 'A3', status: 'warn', detail: 'no clone to check remote auth on' }
    ];
  }

  const checks = [{ id: 'A1', status: 'pass', detail: `clone present at ${localPath}` }];

  // A2 — fetch freshness via FETCH_HEAD's commit date (last `git fetch`).
  try {
    const iso = git('log -1 --format=%cI FETCH_HEAD', localPath);
    const ageMs = Date.now() - Date.parse(iso);
    if (Number.isFinite(ageMs) && ageMs <= FETCH_FRESHNESS_MS) {
      checks.push({ id: 'A2', status: 'pass', detail: `last fetch ${Math.round(ageMs / 3600000)}h ago` });
    } else {
      checks.push({ id: 'A2', status: 'warn', detail: `last fetch ${Math.round(ageMs / 3600000)}h ago (> 48h)` });
    }
  } catch {
    checks.push({ id: 'A2', status: 'warn', detail: 'FETCH_HEAD unreadable — never fetched?' });
  }

  // A3 — auth hygiene, blocking.
  try {
    const remoteUrl = git('remote get-url origin', localPath);
    if (EMBEDDED_CREDENTIAL_RE.test(remoteUrl)) {
      checks.push({ id: 'A3', status: 'fail', detail: 'remote URL contains an embedded token/credential' });
    } else {
      checks.push({ id: 'A3', status: 'pass', detail: 'remote auth clean (no embedded credential)' });
    }
  } catch {
    checks.push({ id: 'A3', status: 'warn', detail: 'origin remote unreadable' });
  }

  return checks;
}
