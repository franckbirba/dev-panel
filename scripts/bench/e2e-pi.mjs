// scripts/bench/e2e-pi.mjs — D1 en local : un vrai item, un vrai agent pi,
// un vrai modèle plancher (Qwen3 via DeepInfra), un vrai commit.
//
// C'est la question qui compte, celle que le runner local ne peut pas poser :
// le harness tient-il quand un modèle FAIBLE doit produire du code utile,
// clore proprement son enveloppe, et laisser un worktree commitable ?
//
// Ce qui est réel ici : le driver pi de prod (spawnPi), les extensions
// vendored, l'enveloppe v1 via submit_result, l'env assaini, le comptage
// d'usage, un dépôt git. Ce qui ne l'est pas : Plane, GitHub, BullMQ — ils
// n'apprennent rien sur le harness et exigeraient la fleet.
//
// usage: node scripts/bench/e2e-pi.mjs [--role builder]
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalSandbox } from './local-fixture.mjs';

const ROLE = process.argv.includes('--role')
  ? process.argv[process.argv.indexOf('--role') + 1] : 'builder';

const t0 = Date.now();
const sandbox = createLocalSandbox();
const log = (...a) => console.log(...a);

log(`sandbox: ${sandbox.work}`);
log(`rôle: ${ROLE} · driver: pi · modèle: Qwen3-Coder (plancher)\n`);

// L'item : petit, spécifié, vérifiable mécaniquement — le format que le
// contrat exige (template agent-ready, ADR-001 §4).
const TASK = `Contexte: petite bibliothèque de calcul dans src/calc.js (add, mul déjà présents).

Travail à faire: ajouter une fonction \`sub(a, b)\` exportée dans src/calc.js qui retourne a - b, et ajouter un test 'subs' dans tests/calc.test.js qui vérifie que sub(5, 3) vaut 2.

Critères d'acceptation:
- src/calc.js exporte sub
- tests/calc.test.js contient un test pour sub
- la suite reste cohérente (3 tests au total)

Fichiers: src/calc.js, tests/calc.test.js
Dépendances: aucune

Quand tu as fini, appelle l'outil submit_result avec status "done", un summary d'une phrase, et artifacts.files_modified listant les fichiers que tu as modifiés.`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

let envelope = null;
let usageSeen = 0;
let spawnError = null;

try {
  process.env.PROJECT_ROOT = process.cwd();
  process.env.DEVPANEL_STORAGE = join(process.cwd(), 'storage-local');
  process.env.DRIVER_BUILDER = 'pi';
  process.env.FORCE_PI_MODEL = 'deepinfra/Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo';
  const logDir = join(process.env.DEVPANEL_STORAGE, 'agent-logs');
  mkdirSync(logDir, { recursive: true });

  const { spawnPi } = await import('../../src/worker/pi-driver.js');
  const activeProcesses = new Map();

  log('→ spawn de l\'agent pi (peut prendre quelques minutes)…\n');
  const out = await spawnPi({
    jobId: `bench-${Date.now()}`,
    prompt: TASK,
    agentRole: ROLE,
    cwd: sandbox.work,
    activeProcesses,
    agentLogDir: logDir,
    onUsage: (u) => {
      const t = (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0) || u?.totalTokens || 0;
      if (t > usageSeen) usageSeen = t;
    },
  });

  // 1. L'enveloppe : c'est le contrat de sortie (ADR-002 §1). Le driver la
  // renvoie déjà normalisée, quelle qu'ait été sa provenance.
  try { envelope = JSON.parse(out); }
  catch {
    const m = out.match(/```json\s*([\s\S]*?)```/);
    if (m) { try { envelope = JSON.parse(m[1]); } catch { /* laissé null */ } }
  }
  check('l\'agent rend une enveloppe exploitable', !!envelope,
    envelope ? `status=${envelope.status}` : `sortie non parsable (${out.slice(0, 80)}…)`);

  if (envelope) {
    check('l\'enveloppe n\'est pas une synthèse de secours',
      !envelope._synthesized,
      envelope._synthesized ? 'reconstruite depuis git — submit_result non appelé' : 'émise par l\'agent');
  }

  // 2. Le travail : le seul juge est le dépôt, pas la parole de l'agent.
  const calc = existsSync(join(sandbox.work, 'src/calc.js'))
    ? readFileSync(join(sandbox.work, 'src/calc.js'), 'utf8') : '';
  const tests = existsSync(join(sandbox.work, 'tests/calc.test.js'))
    ? readFileSync(join(sandbox.work, 'tests/calc.test.js'), 'utf8') : '';
  check('src/calc.js exporte bien sub', /export\s+(function\s+sub|const\s+sub)/.test(calc));
  check('tests/calc.test.js couvre sub', /sub\s*\(/.test(tests));

  // 3. Le diff : un agent qui dit "done" sans rien changer est le pire cas
  // (c'est ce que verifyAndCommit attrape en prod).
  const diff = execFileSync('git', ['status', '--porcelain'], { cwd: sandbox.work, encoding: 'utf8' }).trim();
  check('le worktree porte un vrai diff', diff.length > 0, diff.split('\n').length + ' fichier(s)');

  // 4. Les tests du repo cible — le prédicat tests_green du contrat.
  let green = false, testOut = '';
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd: sandbox.work, stdio: 'pipe', timeout: 180000 });
    execFileSync('npx', ['vitest', 'run'], { cwd: sandbox.work, stdio: 'pipe', timeout: 120000 });
    green = true;
  } catch (e) { testOut = String(e.stdout || e.message).slice(-200); }
  check('la suite du repo cible passe (tests_green)', green, green ? '' : testOut);

  // 5. L'usage : sans ce signal, le budget §6 est inapplicable sur pi.
  check('l\'usage tokens est remonté au worker', usageSeen > 0, `${usageSeen} tokens`);

} catch (err) {
  spawnError = err;
  check('le driver termine sans exception', false, String(err.message).slice(0, 160));
}

const ok = results.filter((r) => r.ok).length;
const ko = results.length - ok;
log(`\n${ok} PASS · ${ko} FAIL · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (envelope?.summary) log(`\nrésumé de l'agent: ${envelope.summary}`);
log(`\nsandbox conservée pour inspection: ${sandbox.work}`);
if (spawnError) log(`\nerreur: ${spawnError.stack?.slice(0, 400)}`);
process.exit(ko === 0 ? 0 : 1);
