// scripts/bench/run-scenario.mjs — exécute UN scénario du bench pour UN driver.
// Appelé par scripts/bench-engine.sh. Émet exactement UNE ligne JSON sur stdout
// (le verdict), appendée à results.jsonl. Le code de sortie n'est ≠0 que si le
// runner lui-même est cassé — les verdicts (PASS/FAIL/…) vivent dans le JSON.
//
// Honnêteté des checks : tout `expect` que le moteur ne rend pas encore
// observable (champs failedReason, compteurs d'itérations…) est rapporté
// CHECK_SKIPPED avec sa raison — jamais un PASS silencieux.
import { readFileSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { waitForInstanceState, assertPrForBranchPrefix, prChecksGreen, instancesFor } from './assert.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- args + env ------------------------------------------------------------
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const ID = arg('id');
const DRIVER = arg('driver', 'claude');
const REPORT_DIR = arg('report', '.');
const need = (k) => {
  if (!process.env[k]) { console.error(`env manquante: ${k} (voir bench.env)`); process.exit(2); }
  return process.env[k];
};
const API = need('API_BASE');
const ADMIN = need('ADMIN_API_KEY');
const REPO = need('BENCH_REPO');
const PLANE_BASE = need('PLANE_BASE_URL');
const PLANE_KEY = need('PLANE_API_KEY');
const SLUG = need('PLANE_WORKSPACE_SLUG');
const PLANE_PROJECT = need('BENCH_PLANE_PROJECT_ID');

const scenario = JSON.parse(readFileSync(join(__dirname, 'scenarios.json'), 'utf8'))
  .scenarios.find((s) => s.id === ID);
if (!scenario) { console.error(`scénario inconnu: ${ID}`); process.exit(2); }

// --- clients ---------------------------------------------------------------
async function mcp(tool, args) {
  const r = await fetch(`${API}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ADMIN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const text = await r.text();
  // Transport HTTP MCP : réponse JSON directe ou enveloppe SSE (`data: {...}`).
  const jsonText = text.startsWith('event:') || text.includes('\ndata:')
    ? text.split('\n').filter((l) => l.startsWith('data:')).pop()?.slice(5)
    : text;
  const parsed = JSON.parse(jsonText);
  if (parsed.error) throw new Error(`mcp ${tool}: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

async function plane(path, body) {
  const r = await fetch(
    `${PLANE_BASE}/api/v1/workspaces/${SLUG}/projects/${PLANE_PROJECT}${path}`,
    { method: 'POST', headers: { 'X-API-Key': PLANE_KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (!r.ok) throw new Error(`plane ${path} → HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// --- steps -----------------------------------------------------------------
const checks = [];
const check = (name, status, detail = '') => { checks.push({ name, status, detail }); };
const RUN_TAG = `${ID}-${DRIVER}-${Date.now().toString(36)}`;

async function preHook() {
  if (scenario.pre !== 'plant_failing_test') return;
  const dir = mkdtempSync(join(tmpdir(), 'bench-plant-'));
  execSync(`git clone -q --depth 1 git@github.com:${REPO}.git ${dir}`);
  writeFileSync(join(dir, 'tests', 'planted.test.js'),
    "import { describe, it, expect } from 'vitest';\n" +
    "import { div } from '../src/calc.js';\n" +
    "describe('planted', () => { it('divs', () => expect(div(6, 3)).toBe(2)); });\n");
  execSync('git add tests/planted.test.js && git -c user.email=bench@devpanl.dev -c user.name=bench commit -qm "bench: plant failing test (D7)" && git push -q', { cwd: dir, shell: '/bin/bash' });
}

async function createWorkItems() {
  const map = {};
  for (const wi of scenario.work_items) {
    const issue = await plane('/issues/', {
      name: `${wi.title} [${RUN_TAG}]`,
      description_html: `<p>${wi.description.replaceAll('\n', '<br/>')}</p>`,
    });
    map[wi.key] = issue.id;
  }
  for (const wi of scenario.work_items) {
    if (!wi.blocked_by) continue;
    // Shape de l'API relations validée au premier run live (cf. README §Première exécution).
    await plane(`/issues/${map[wi.key]}/relations/`, { relation_type: 'blocked_by', issues: [map[wi.blocked_by]] });
  }
  return map;
}

async function dispatch(map) {
  const ids = scenario.work_items.map((wi) => map[wi.key]);
  if (ids.length === 1) return mcp('dispatch_work_item', { work_item_id: ids[0] });
  return mcp('dispatch_wave', { work_item_ids: ids, max_parallel: 2 });
}

async function midRunAction(map) {
  if (!scenario.action_mid_run) return;
  const first = map[scenario.work_items[0].key];
  const { instance } = await waitForInstanceState({ work_item_id: first, states: ['running'], timeoutMs: 300_000 });
  if (scenario.action_mid_run === 'cancel') {
    await mcp('cancel_job', { job_id: String(instance.last_job_id) });
  } else if (scenario.action_mid_run === 'kill_worker') {
    execSync(need('BENCH_KILL_WORKER_CMD'), { shell: '/bin/bash', stdio: 'pipe' });
  }
}

async function runChecks(map) {
  const e = scenario.expect;
  const firstId = map[scenario.work_items[0].key];
  for (const [key, val] of Object.entries(e)) {
    try {
      switch (key) {
        case 'instance_state': {
          const { state } = await waitForInstanceState({ work_item_id: firstId, states: [val] });
          check(key, 'PASS', state); break;
        }
        case 'instance_state_in': {
          const { state } = await waitForInstanceState({ work_item_id: firstId, states: val });
          check(key, 'PASS', state); break;
        }
        case 'all_completed': {
          for (const wi of scenario.work_items) {
            await waitForInstanceState({ work_item_id: map[wi.key], states: ['completed'] });
          }
          check(key, 'PASS', `${scenario.work_items.length} items`); break;
        }
        case 'pr_open': {
          const pr = assertPrForBranchPrefix({ repo: REPO, prefix: `feat/wi-${String(firstId).slice(0, 8)}` });
          check(key, 'PASS', `#${pr.number}`); break;
        }
        case 'pr_ci_green': {
          const pr = assertPrForBranchPrefix({ repo: REPO, prefix: `feat/wi-${String(firstId).slice(0, 8)}` });
          check(key, prChecksGreen({ repo: REPO, number: pr.number }) ? 'PASS' : 'FAIL', `#${pr.number}`); break;
        }
        case 'order_by_merge': {
          const merged = val.map((k) => {
            const pr = assertPrForBranchPrefix({ repo: REPO, prefix: `feat/wi-${String(map[k]).slice(0, 8)}`, expectOpen: false });
            if (!pr?.mergedAt) throw new Error(`${k}: PR non mergée`);
            return { k, at: new Date(pr.mergedAt).getTime() };
          });
          const sorted = [...merged].sort((a, b) => a.at - b.at).map((m) => m.k);
          check(key, JSON.stringify(sorted) === JSON.stringify(val) ? 'PASS' : 'FAIL', sorted.join(' → ')); break;
        }
        case 'no_zombie_instances': {
          let zombies = 0;
          for (const wi of scenario.work_items) {
            const rows = await instancesFor(map[wi.key]);
            zombies += rows.filter((r) => ['running', 'awaiting_approval'].includes(r.status)).length;
          }
          check(key, zombies === 0 ? 'PASS' : 'FAIL', `${zombies} zombie(s)`); break;
        }
        default:
          // max_agent_runs, notified, reason_in, rescue_pr_if_diff, no_process_leak,
          // worktree_reclaimed, no_double_dispatch, job_terminal_with_reason,
          // loop_exited_by, iterations_lte : observables une fois C2/C8 livrés
          // (champs reason/itérations exposés par l'engine). Jamais de PASS silencieux.
          check(key, 'CHECK_SKIPPED', 'observable après C2/C8 — champ non exposé par le moteur actuel');
      }
    } catch (err) {
      check(key, err.pending ? 'CHECK_SKIPPED' : 'FAIL', String(err.message ?? err).slice(0, 200));
    }
  }
}

// --- main ------------------------------------------------------------------
let result;
try {
  await preHook();
  const map = await createWorkItems();
  const dispatchPromise = dispatch(map);
  await midRunAction(map);
  await dispatchPromise.catch((e) => check('dispatch', 'FAIL', String(e.message).slice(0, 200)));
  await runChecks(map);
  const failed = checks.some((c) => c.status === 'FAIL');
  const passed = checks.some((c) => c.status === 'PASS');
  result = { scenario: ID, driver: DRIVER, run_tag: RUN_TAG, result: failed ? 'FAIL' : passed ? 'PASS' : 'CHECK_SKIPPED', checks, work_items: map };
} catch (err) {
  result = { scenario: ID, driver: DRIVER, run_tag: RUN_TAG, result: 'RUNNER_ERROR', error: String(err.message ?? err), checks };
}
appendFileSync(join(REPORT_DIR, `scenario-${ID}-${DRIVER}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
