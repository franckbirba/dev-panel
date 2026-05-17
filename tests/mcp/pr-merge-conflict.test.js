// tests/mcp/pr-merge-conflict.test.js
//
// DEVPA-227 smoke tests. Uses a real local git repo seeded with a known
// conflict so the parser + worktree dance run for real — mocking git/parse
// here would test the mocks, not the tool.
//
// `getProjectByGithubRepo` and `gh pr view` are stubbed: db is a Mac
// SQLite the tool can't see in a vitest sandbox, and `gh` would hit
// GitHub which is exactly the round-trip we want to avoid.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/server/db.js', () => ({
  getProjectByGithubRepo: vi.fn()
}));

let stubbedRepo = null;
let stubbedPrView = null;

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execFileSync: (cmd, args, opts) => {
      if (cmd === 'gh' && Array.isArray(args) && args[0] === 'pr') {
        if (!stubbedPrView) throw new Error('gh stub not configured');
        return JSON.stringify(stubbedPrView);
      }
      return actual.execFileSync(cmd, args, opts);
    }
  };
});

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

function seedConflictRepo() {
  // origin (bare) + working clone. Branch `main` with file foo.txt, branch
  // `feat/x` mutates the same line. Merging feat/x onto main triggers a
  // single conflict in foo.txt.
  const root = mkdtempSync(join(tmpdir(), 'devpa227-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  execFileSync('git', ['clone', origin, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  // Base commit on main
  writeFileSync(join(work, 'foo.txt'), 'alpha\nbeta\ngamma\ndelta\nepsilon\n');
  writeFileSync(join(work, 'untouched.txt'), 'unchanged\n');
  git(work, 'add', 'foo.txt', 'untouched.txt');
  git(work, 'commit', '-m', 'base');
  git(work, 'push', 'origin', 'main');
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  // main moves forward — mutate line 3
  writeFileSync(join(work, 'foo.txt'), 'alpha\nbeta\nGAMMA-MAIN\ndelta\nepsilon\n');
  git(work, 'commit', '-am', 'main update');
  git(work, 'push', 'origin', 'main');
  const mainSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  // feat/x branches from baseSha and mutates the same line
  git(work, 'checkout', '-b', 'feat/x', baseSha);
  writeFileSync(join(work, 'foo.txt'), 'alpha\nbeta\ngamma-feat\ndelta\nepsilon\n');
  git(work, 'commit', '-am', 'feat update');
  git(work, 'push', 'origin', 'feat/x');
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  git(work, 'checkout', 'main');
  return { root, origin, work, baseSha, mainSha, headSha };
}

function seedCleanRepo() {
  // Same as above but the feat branch touches a different file → clean merge.
  const root = mkdtempSync(join(tmpdir(), 'devpa227-clean-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  execFileSync('git', ['clone', origin, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  writeFileSync(join(work, 'foo.txt'), 'alpha\nbeta\n');
  git(work, 'add', 'foo.txt');
  git(work, 'commit', '-m', 'base');
  git(work, 'push', 'origin', 'main');
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  git(work, 'checkout', '-b', 'feat/clean');
  writeFileSync(join(work, 'bar.txt'), 'new file\n');
  git(work, 'add', 'bar.txt');
  git(work, 'commit', '-m', 'add bar');
  git(work, 'push', 'origin', 'feat/clean');
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  git(work, 'checkout', 'main');
  return { root, origin, work, baseSha, headSha };
}

let prMergeConflict, __clearCacheForTests;
let getProjectByGithubRepo;

beforeEach(async () => {
  vi.resetModules();
  stubbedRepo = null;
  stubbedPrView = null;
  const mod = await import('../../src/mcp/pr-merge-conflict.js');
  prMergeConflict = mod.prMergeConflict;
  __clearCacheForTests = mod.__clearCacheForTests;
  __clearCacheForTests();
  const dbMod = await import('../../src/server/db.js');
  getProjectByGithubRepo = dbMod.getProjectByGithubRepo;
});

describe('pr_merge_conflict — input validation', () => {
  it('rejects pr_id not matching <owner>/<repo>#<number>', async () => {
    await expect(prMergeConflict({ pr_id: 'not-a-pr' })).rejects.toMatchObject({
      code: 'bad_pr_id'
    });
  });

  it('errors when the projects row is missing', async () => {
    getProjectByGithubRepo.mockReturnValue(null);
    await expect(prMergeConflict({ pr_id: 'acme/widget#42' })).rejects.toMatchObject({
      code: 'project_not_found'
    });
  });

  it('errors when the projects row has no local_path', async () => {
    getProjectByGithubRepo.mockReturnValue({ id: 'p1', local_path: null });
    await expect(prMergeConflict({ pr_id: 'acme/widget#42' })).rejects.toMatchObject({
      code: 'project_not_linked'
    });
  });
});

describe('pr_merge_conflict — happy paths', () => {
  it('returns parsed hunks for a conflicting PR', async () => {
    const repo = seedConflictRepo();
    stubbedRepo = repo;
    getProjectByGithubRepo.mockReturnValue({ local_path: repo.work, id: 'p1' });
    stubbedPrView = {
      number: 42, title: 'feat: collide',
      headRefName: 'feat/x', headRefOid: repo.headSha,
      baseRefName: 'main', baseRefOid: repo.mainSha
    };

    try {
      const out = await prMergeConflict({ pr_id: 'acme/widget#42' });
      expect(out.pr.number).toBe(42);
      expect(out.pr.repo).toBe('acme/widget');
      expect(out.pr.head_sha).toBe(repo.headSha);
      expect(out.pr.base_sha).toBe(repo.mainSha);
      expect(out.conflicts).toHaveLength(1);
      const c = out.conflicts[0];
      expect(c.path).toBe('foo.txt');
      expect(c.hunks).toHaveLength(1);
      const h = c.hunks[0];
      expect(h.id).toMatch(/^[0-9a-f]{16}$/);
      expect(h.ours.join('\n')).toContain('GAMMA-MAIN');
      expect(h.theirs.join('\n')).toContain('gamma-feat');
      expect(h.context_before.length).toBeGreaterThan(0);
      expect(h.context_after.length).toBeGreaterThan(0);

      // Worktree should be cleaned up
      const wtBase = join(repo.work, '.devpanel-worktrees');
      const remaining = existsSync(wtBase)
        ? execFileSync('ls', [wtBase], { encoding: 'utf8' }).trim()
        : '';
      expect(remaining).toBe('');
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it('returns empty conflicts[] for a clean merge', async () => {
    const repo = seedCleanRepo();
    getProjectByGithubRepo.mockReturnValue({ local_path: repo.work, id: 'p2' });
    stubbedPrView = {
      number: 7, title: 'feat: clean',
      headRefName: 'feat/clean', headRefOid: repo.headSha,
      baseRefName: 'main', baseRefOid: repo.baseSha
    };
    try {
      const out = await prMergeConflict({ pr_id: 'acme/widget#7' });
      expect(out.conflicts).toEqual([]);
      expect(out.pr.head_sha).toBe(repo.headSha);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it('caches the merge result by (pr_id, head_sha) for 60s', async () => {
    const repo = seedConflictRepo();
    getProjectByGithubRepo.mockReturnValue({ local_path: repo.work, id: 'p3' });
    stubbedPrView = {
      number: 42, title: 't',
      headRefName: 'feat/x', headRefOid: repo.headSha,
      baseRefName: 'main', baseRefOid: repo.mainSha
    };
    try {
      const first = await prMergeConflict({ pr_id: 'acme/widget#42' });
      const second = await prMergeConflict({ pr_id: 'acme/widget#42' });
      // generated_at is set inside the merge path; cache hit returns the
      // exact same payload object (including its timestamp).
      expect(second.generated_at).toBe(first.generated_at);
      expect(second).toBe(first);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
});
