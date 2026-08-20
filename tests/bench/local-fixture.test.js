// La sandbox locale du bench doit être une vraie cible git : on peut pousser
// dessus, lire les branches, lire les commits. Si ces invariants cassent, le
// bench local mesure du vide.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createLocalSandbox, plantFailingTest, pushedBranches, branchCommits,
} from '../../scripts/bench/local-fixture.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('bench local fixture', () => {
  let sandbox;
  afterEach(() => { sandbox?.cleanup(); sandbox = null; });

  it('crée un remote bare et un clone peuplé par le seed', () => {
    sandbox = createLocalSandbox();
    expect(existsSync(join(sandbox.remote, 'HEAD'))).toBe(true);
    expect(existsSync(join(sandbox.work, 'src', 'calc.js'))).toBe(true);
    expect(pushedBranches(sandbox)).toContain('main');
  });

  it('ignore .devpanel-worktrees (précondition ADR-003 R3)', () => {
    sandbox = createLocalSandbox();
    expect(readFileSync(join(sandbox.work, '.gitignore'), 'utf8')).toContain('.devpanel-worktrees/');
  });

  it('accepte une branche poussée et en expose les commits', () => {
    sandbox = createLocalSandbox();
    git(['checkout', '-q', '-b', 'feat/wi-abc-demo'], sandbox.work);
    execFileSync('sh', ['-c', 'echo "export const sub = (a,b) => a-b;" >> src/calc.js'], { cwd: sandbox.work });
    git(['add', 'src/calc.js'], sandbox.work);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'feat: sub'], sandbox.work);
    git(['push', '-q', 'origin', 'feat/wi-abc-demo'], sandbox.work);

    expect(pushedBranches(sandbox)).toContain('feat/wi-abc-demo');
    const commits = branchCommits(sandbox, 'feat/wi-abc-demo');
    expect(commits).toHaveLength(1);
    expect(commits[0]).toContain('feat: sub');
  });

  it('plante un test rouge pour D7 (la suite doit échouer avant le fix)', () => {
    sandbox = createLocalSandbox();
    plantFailingTest(sandbox);
    expect(existsSync(join(sandbox.work, 'tests', 'planted.test.js'))).toBe(true);
    // Le test planté importe `div`, qui n'existe pas dans le seed : c'est
    // exactement l'état rouge que la boucle interne doit résoudre.
    expect(readFileSync(join(sandbox.work, 'src', 'calc.js'), 'utf8')).not.toContain('export function div');
  });

  it('est idempotent — recréer sur le même root repart d\'une baseline propre', () => {
    sandbox = createLocalSandbox();
    plantFailingTest(sandbox);
    const again = createLocalSandbox({ root: sandbox.root });
    expect(existsSync(join(again.work, 'tests', 'planted.test.js'))).toBe(false);
    expect(pushedBranches(again)).toEqual(['main']);
  });
});
