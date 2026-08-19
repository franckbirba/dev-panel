// scripts/bench/assert.mjs — prédicats d'assertion du bench moteur.
// Utilisé comme module par run-scenario.mjs, ou en CLI :
//   node assert.mjs waitForInstanceState '{"work_item_id":"…","states":["completed"]}'
// exit 0 = pass · 1 = fail · 3 = timeout d'attente.
import { execSync } from 'node:child_process';

const API = process.env.API_BASE;
const KEY = process.env.ADMIN_API_KEY;

async function api(path) {
  const r = await fetch(`${API}${path}`, { headers: { 'X-Admin-Key': KEY } });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

export async function instancesFor(work_item_id) {
  return api(`/api/admin/workflow-instances?work_item_id=${encodeURIComponent(work_item_id)}`);
}

export async function waitForInstanceState({ work_item_id, states, timeoutMs = 900_000, pollMs = 10_000 }) {
  const until = Date.now() + timeoutMs;
  const TERMINAL = ['failed', 'exhausted', 'cancelled', 'completed'];
  while (Date.now() < until) {
    const rows = await instancesFor(work_item_id);
    const st = rows[0]?.status;
    if (st && states.includes(st)) return { state: st, instance: rows[0] };
    if (st && TERMINAL.includes(st) && !states.includes(st)) {
      throw new Error(`terminal inattendu: ${st} (attendu: ${states.join('|')})`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const err = new Error(`timeout en attendant ${states.join('|')} sur ${work_item_id}`);
  err.isWaitTimeout = true;
  throw err;
}

export function assertPrForBranchPrefix({ repo, prefix, expectOpen = true }) {
  const out = execSync(
    `gh pr list -R ${repo} --state all --json headRefName,state,number,mergedAt`,
    { encoding: 'utf8' },
  );
  const pr = JSON.parse(out).find((p) => p.headRefName.startsWith(prefix));
  if (expectOpen && !pr) throw new Error(`aucune PR avec préfixe de branche ${prefix} sur ${repo}`);
  return pr ?? null;
}

export function prChecksGreen({ repo, number }) {
  // gh pr checks exit 0 = tous verts ; exit 8 = pending ; autre = failing.
  try {
    execSync(`gh pr checks ${number} -R ${repo}`, { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch (e) {
    if (e.status === 8) throw Object.assign(new Error('checks pending'), { pending: true });
    return false;
  }
}

// --- CLI -------------------------------------------------------------------
const [, , fn, rawArgs] = process.argv;
if (fn) {
  const fns = { waitForInstanceState, assertPrForBranchPrefix, prChecksGreen, instancesFor };
  if (!fns[fn]) { console.error(`fonction inconnue: ${fn}`); process.exit(2); }
  Promise.resolve(fns[fn](JSON.parse(rawArgs || '{}')))
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => {
      console.error(String(e));
      process.exit(e.isWaitTimeout ? 3 : 1);
    });
}
