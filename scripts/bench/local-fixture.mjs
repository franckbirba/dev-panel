// scripts/bench/local-fixture.mjs — sandbox du bench, version 100% locale.
//
// Le bench "prod" exerce Plane + GitHub + l'agents host (c'est son intérêt :
// zéro mock). Mais pour itérer sur le MOTEUR — sémantique d'échec, boucles,
// timeouts, réconciliation — dépendre de deux SaaS et d'un VPS transforme
// chaque run en épreuve d'infra. Ce module fournit la même surface, en local :
//
//   - un repo git **bare** sur disque tient lieu de "remote GitHub" ; on peut
//     y pousser, en lire les branches, vérifier les commits.
//   - un clone de travail sert de `local_path` au projet.
//   - les work items sont des lignes en base (pas d'appel Plane).
//
// Ce que ça ne teste PAS : les webhooks GitHub, les relations Plane, le
// merge-coordinator réel. Ces scénarios restent gated sur le bench prod.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), 'sandbox-seed');

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * Crée (ou recrée) la sandbox locale : un remote bare + un clone de travail
 * peuplé par le seed. Idempotent — c'est l'équivalent de `setup-sandbox.sh
 * reset`, sans réseau.
 *
 * @returns {{ root, remote, work, cleanup }}
 */
export function createLocalSandbox({ root } = {}) {
  const base = root || mkdtempSync(join(tmpdir(), 'devpanl-bench-'));
  const remote = join(base, 'remote.git');
  const work = join(base, 'work');

  for (const p of [remote, work]) if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  mkdirSync(remote, { recursive: true });
  git(['init', '--bare', '-b', 'main'], remote);

  mkdirSync(work, { recursive: true });
  git(['init', '-b', 'main'], work);
  git(['remote', 'add', 'origin', remote], work);
  cpSync(SEED_DIR, work, { recursive: true });
  // Le worker exige que .devpanel-worktrees soit ignoré (ADR-003 R3) — le
  // seed le porte déjà, on vérifie plutôt que de le supposer.
  const gitignore = join(work, '.gitignore');
  if (!existsSync(gitignore)) writeFileSync(gitignore, 'node_modules/\n.devpanel-worktrees/\n');
  git(['add', '-A'], work);
  git(['-c', 'user.email=bench@devpanl.dev', '-c', 'user.name=bench', 'commit', '-m', 'bench baseline'], work);
  git(['push', '-q', 'origin', 'main'], work);

  return {
    root: base,
    remote,
    work,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** Plante un test rouge (scénario D7 — exige la boucle interne test→fix). */
export function plantFailingTest(sandbox) {
  const path = join(sandbox.work, 'tests', 'planted.test.js');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    "import { describe, it, expect } from 'vitest';\n" +
    "import { div } from '../src/calc.js';\n" +
    "describe('planted', () => { it('divs', () => expect(div(6, 3)).toBe(2)); });\n",
  );
  git(['add', 'tests/planted.test.js'], sandbox.work);
  git(['-c', 'user.email=bench@devpanl.dev', '-c', 'user.name=bench', 'commit', '-m', 'bench: plant failing test (D7)'], sandbox.work);
  git(['push', '-q', 'origin', 'main'], sandbox.work);
}

/** Les branches poussées sur le remote — l'équivalent local de `gh pr list`. */
export function pushedBranches(sandbox) {
  return git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], sandbox.remote)
    .split('\n')
    .filter(Boolean);
}

/** Les commits d'une branche non présents sur main — le "diff de la PR". */
export function branchCommits(sandbox, branch) {
  try {
    return git(['log', '--pretty=%H %s', `main..${branch}`], sandbox.remote)
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}
