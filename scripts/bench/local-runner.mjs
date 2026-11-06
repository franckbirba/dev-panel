// scripts/bench/local-runner.mjs — le bench moteur, exécutable en local.
//
// Le bench « prod » (bench-engine.sh) exerce Plane + GitHub + l'agents host :
// c'est son intérêt, zéro mock. Mais il exige une fleet allumée, et la fleet
// est volontairement éteinte tant que le moteur n'est pas prouvé. Poule et
// œuf.
//
// Ce runner casse la boucle : il exerce les MÊMES invariants du contrat
// contre la fixture locale (repo git bare + Postgres local), sans réseau, ni
// Plane, ni GitHub, ni modèle. Il ne remplace pas le bench prod — il le
// précède. Ce qu'il ne peut pas tester (un agent réel qui produit du code,
// les webhooks) reste gated là-bas.
//
// Chaque scénario rend PASS / FAIL / SKIP avec une raison, jamais un silence.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalSandbox, plantFailingTest, pushedBranches } from './local-fixture.mjs';

const results = [];
const record = (id, name, status, detail = '') => {
  results.push({ id, name, status, detail });
  const icon = { PASS: '✅', FAIL: '❌', SKIP: '⏭️ ' }[status] ?? '  ';
  console.log(`${icon} ${id} — ${name}${detail ? ` (${detail})` : ''}`);
};

async function scenario(id, name, fn) {
  try {
    const detail = await fn();
    record(id, name, 'PASS', detail);
  } catch (err) {
    if (err?.skip) record(id, name, 'SKIP', err.message);
    else record(id, name, 'FAIL', String(err.message ?? err).slice(0, 160));
  }
}
const skip = (msg) => Object.assign(new Error(msg), { skip: true });

// ── L1 : le graphe et ses boucles (ADR-006) ─────────────────────────────────
await scenario('L1', 'les 4 workflows chargent, work-item porte une boucle bornée', async () => {
  const { loadWorkflows } = await import('../../src/worker/engine.js');
  const flows = loadWorkflows();
  const names = Object.keys(flows).sort();
  if (names.length !== 4) throw new Error(`4 workflows attendus, ${names.length} chargés`);
  const loop = flows['work-item'].graph.loops.find((l) => l.id === 'revision');
  if (!loop) throw new Error('boucle `revision` absente de work-item');
  if (!loop.max_iterations || !loop.budget_tokens) throw new Error('boucle sans borne ni budget');
  return `revision: ${loop.max_iterations} itérations, ${loop.budget_tokens / 1000}k tokens`;
});

await scenario('L2', 'un cycle non déclaré est rejeté AU CHARGEMENT', async () => {
  const { loadWorkflows } = await import('../../src/worker/engine.js');
  const dir = mkdtempSync(join(tmpdir(), 'bench-cycle-'));
  writeFileSync(join(dir, 'bad.yaml'),
    'name: undeclared-cycle\nnodes:\n  - {id: a, agent: builder}\n  - {id: b, agent: reviewer}\n'
    + 'edges:\n  - {from: a, on: done, to: b}\n  - {from: b, on: failed, to: a}\n'
    + '  - {from: b, on: done, terminal: true}\n');
  try {
    loadWorkflows(dir);
    throw new Error('ACCEPTÉ alors qu\'il fallait rejeter');
  } catch (e) {
    if (!/cycle/i.test(e.message)) throw e;
    return 'rejet avec le cycle nommé';
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await scenario('L3', 'un `until` inconnu est rejeté au chargement', async () => {
  const { loadWorkflows } = await import('../../src/worker/engine.js');
  const dir = mkdtempSync(join(tmpdir(), 'bench-until-'));
  writeFileSync(join(dir, 'bad.yaml'),
    'name: bad-until\nnodes:\n  - {id: a, agent: builder}\n  - {id: b, agent: reviewer}\n'
    + 'loops:\n  - {id: l, body: [a,b], until: fantome, max_iterations: 2, budget_tokens: 100}\n'
    + 'edges:\n  - {from: a, on: done, to: b}\n  - {from: b, on: failed, to: a}\n'
    + '  - {from: b, on: done, terminal: true}\n');
  try {
    loadWorkflows(dir);
    throw new Error('ACCEPTÉ alors qu\'il fallait rejeter');
  } catch (e) {
    if (!/unknown predicate/i.test(e.message)) throw e;
    return 'rejet du prédicat fantôme';
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── L4 : l'ordonnancement des vagues (ADR-001) ──────────────────────────────
await scenario('L4', 'une chaîne de 3 items est ordonnée, un cycle est refusé', async () => {
  const { planWave, nextFront, applyMerged } = await import('../../src/worker/wave-planner.js');
  const plan = planWave([
    { id: 'kernel', blocked_by: [] },
    { id: 'resolver', blocked_by: ['kernel'] },
    { id: 'pilote', blocked_by: ['resolver'] },
  ]);
  if (JSON.stringify(plan.fronts) !== JSON.stringify([['kernel'], ['resolver'], ['pilote']])) {
    throw new Error(`ordre inattendu: ${JSON.stringify(plan.fronts)}`);
  }
  const front = nextFront(plan, { merged: [], running: [], failed: [], max_parallel: 2 });
  if (front.join() !== 'kernel') throw new Error(`front initial: ${front.join()}`);
  const after = applyMerged(plan, { merged: [], running: ['kernel'], failed: [], max_parallel: 2 }, 'kernel');
  if (after.unblocked.join() !== 'resolver') throw new Error('resolver non armé au merge du kernel');

  let cycleRefused = false;
  try { planWave([{ id: 'a', blocked_by: ['b'] }, { id: 'b', blocked_by: ['a'] }]); }
  catch { cycleRefused = true; }
  if (!cycleRefused) throw new Error('cycle de dépendances accepté');
  return 'ordre respecté, cycle refusé';
});

// ── L5 : la taxonomie d'échec (contrat §4.2) ────────────────────────────────
await scenario('L5', 'chaque classe d\'échec a sa borne, pas de retry aveugle', async () => {
  const fc = await import('../../src/worker/failure-classifier.js');
  const infraFirst = fc.decideInfraRetry(0);
  const infraExhausted = fc.decideInfraRetry(2);
  if (!infraFirst.shouldRetry) throw new Error('infra_failure devrait retenter');
  if (infraExhausted.shouldRetry) throw new Error('infra_failure devrait s\'arrêter à 2');
  const envFirst = fc.decideEnvelopeRetry(0);
  const envSecond = fc.decideEnvelopeRetry(1);
  if (!envFirst.shouldRetry) throw new Error('enveloppe invalide: 1 retry-with-feedback attendu');
  if (envSecond.shouldRetry) throw new Error('enveloppe invalide: le retry doit être UNIQUE');
  const fb = fc.buildEnvelopeFeedback('status manquant');
  if (!fb || !/status/i.test(fb)) throw new Error('le feedback ne porte pas l\'erreur de validation');
  return 'infra 2 max, enveloppe 1 feedback, jamais de retry aveugle';
});

// ── L6 : bornes de temps et de budget (contrat §5/§6) ───────────────────────
await scenario('L6', 'les bornes sont définies par rôle et le plafond fleet gate l\'admission', async () => {
  const tp = await import('../../src/worker/timeout-policy.js');
  const builder = tp.agentTimeoutMs('builder');
  const reviewer = tp.agentTimeoutMs('reviewer');
  if (!(builder > 0 && reviewer > 0)) throw new Error('timeouts non définis');
  if (!(builder >= reviewer)) throw new Error('le builder devrait avoir au moins autant de marge');
  const lock = tp.computeLockDurationMs();
  if (lock <= builder) throw new Error('invariant §5 violé: lockDuration <= max(timeout)');

  const { checkSpendGate } = await import('../../src/worker/spend-gate.js');
  if (checkSpendGate({ spentTodayEur: 99, limitEur: 15 }).admitted) {
    throw new Error('le plafond fleet devrait refuser l\'admission');
  }
  if (!checkSpendGate({ spentTodayEur: 99, limitEur: 15, priority: 'urgent' }).admitted) {
    throw new Error('un dispatch urgent devrait passer outre');
  }
  return `builder ${builder / 60000}min, lock ${lock / 60000}min, plafond gate l'entrée`;
});

// ── L7 : cancel distinguable d'un plantage (contrat §7) ─────────────────────
await scenario('L7', 'un cancel est distinguable d\'un plantage', async () => {
  const { createCancelHandler, wasCancelRequested } = await import('../../src/worker/worker-control.js');
  const procs = new Map([
    ['cancelled', { process: { pid: 1, kill() {} }, startedAt: 0 }],
    ['crashed', { process: { pid: 2, kill() {} }, startedAt: 0 }],
  ]);
  createCancelHandler(procs, () => {})({ type: 'cancel', job_id: 'cancelled' });
  if (!wasCancelRequested(procs, 'cancelled')) throw new Error('intention de cancel non marquée');
  if (wasCancelRequested(procs, 'crashed')) throw new Error('un plantage passe pour un cancel');
  return 'intention marquée avant le kill';
});

// ── L8 : réconciliation au boot, sans re-dispatch (contrat §8) ──────────────
await scenario('L8', 'un job orphelin est terminé, JAMAIS re-dispatché', async () => {
  const br = await import('../../src/worker/boot-reconciler.js');
  const decide = br.decideOrphanedActiveJobs ?? br.decideOrphanedActiveJob;
  if (typeof decide !== 'function') throw skip('decideOrphanedActiveJobs non exporté');
  // Un job actif sans process vivant est orphelin : il doit être terminé,
  // jamais relancé (le worktree est dans un état inconnu). On inspecte
  // l'action décidée, pas une sous-chaîne du JSON — `fail_no_rerun` contient
  // "rerun" et faisait crier au loup une première version de ce check.
  const orphan = decide([{ id: '1', data: {} }], new Set())[0];
  if (!orphan) throw new Error('le job orphelin n\'a produit aucune décision');
  if (orphan.action !== 'fail_no_rerun') {
    throw new Error(`action attendue fail_no_rerun, obtenu: ${orphan.action}`);
  }
  // Et un job dont le process tourne encore ne doit PAS être touché.
  const alive = decide([{ id: '2', data: {} }], new Set(['2']));
  if (alive.length !== 0) throw new Error('un job encore vivant a été réconcilié à tort');
  return 'orphelin → failed sans re-run, job vivant intact';
});

// ── L9 : la sandbox locale est une vraie cible git ──────────────────────────
await scenario('L9', 'la sandbox accepte une branche poussée (dispatch → worktree → push)', async () => {
  const sandbox = createLocalSandbox();
  try {
    const git = (args) => execFileSync('git', args, { cwd: sandbox.work, encoding: 'utf8' });
    git(['checkout', '-q', '-b', 'feat/wi-bench-demo']);
    writeFileSync(join(sandbox.work, 'src', 'calc.js'),
      'export function add(a, b) { return a + b; }\nexport function mul(a, b) { return a * b; }\nexport function sub(a, b) { return a - b; }\n');
    git(['add', 'src/calc.js']);
    git(['-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-m', 'feat: sub']);
    git(['push', '-q', 'origin', 'feat/wi-bench-demo']);
    if (!pushedBranches(sandbox).includes('feat/wi-bench-demo')) throw new Error('branche non reçue par le remote');
    plantFailingTest(sandbox);
    if (!existsSync(join(sandbox.work, 'tests', 'planted.test.js'))) throw new Error('test rouge non planté');
    return 'branche poussée + état rouge pour la boucle interne';
  } finally { sandbox.cleanup(); }
});

// ── D1/D2 : le vrai bout-en-bout, hors scope local ──────────────────────────
record('D1', 'item réel → PR verte (agent + GitHub)', 'SKIP', 'exige la fleet + un modèle — bench prod');
record('D2', 'chaîne réelle via dispatch_wave (Plane)', 'SKIP', 'exige Plane + la fleet — bench prod');

// ── verdict ─────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n${pass} PASS · ${fail} FAIL · ${skipped} SKIP`);
console.log(fail === 0
  ? '\n🟢 Invariants du contrat vérifiés en local. Le bout-en-bout réel (D1–D7 sur modèle plancher) reste à faire sur le bench prod avant tout go Zeno.'
  : '\n🔴 Des invariants du contrat sont violés — voir les FAIL ci-dessus.');
process.exit(fail === 0 ? 0 : 1);
