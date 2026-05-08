// DEVPA-144 — per-job worktree isolation
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ORIGINAL_ENV = { ...process.env };

let workdir;

beforeEach(async () => {
  workdir = await fs.mkdtemp(join(tmpdir(), 'wt-'));
  process.env = {
    ...ORIGINAL_ENV,
    DEVPANEL_STORAGE: workdir,
    DEVPANEL_WORKTREES: join(workdir, 'worktrees'),
    DEVPANEL_WORKTREES_ENABLED: 'true',
    PROJECT_ROOT: workdir + '/repo'
  };
  vi.resetModules();
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  await fs.rm(workdir, { recursive: true, force: true });
});

function captureExec() {
  const calls = [];
  vi.doMock('child_process', () => ({
    execSync: vi.fn((cmd, opts) => {
      calls.push({ cmd, opts });
      // Simulate "branch does not exist" for rev-parse so the new-branch path
      // is exercised. Tests can override per-call below.
      if (cmd.includes('rev-parse --verify')) {
        const err = new Error('not found');
        err.status = 128;
        throw err;
      }
      return '';
    })
  }));
  return calls;
}

describe('worktree — shouldUseWorktree', () => {
  it('returns false for non-coding agents', async () => {
    captureExec();
    const { shouldUseWorktree } = await import('../../src/worker/worktree.js');
    expect(shouldUseWorktree('pm')).toBe(false);
    expect(shouldUseWorktree('architect')).toBe(false);
    expect(shouldUseWorktree('designer')).toBe(false);
    expect(shouldUseWorktree('deploy')).toBe(false);
    expect(shouldUseWorktree('bootstrap')).toBe(false);
    expect(shouldUseWorktree('shelly_digest')).toBe(false);
  });

  it('returns true for coding agents', async () => {
    captureExec();
    const { shouldUseWorktree } = await import('../../src/worker/worktree.js');
    expect(shouldUseWorktree('builder')).toBe(true);
    expect(shouldUseWorktree('reviewer')).toBe(true);
    expect(shouldUseWorktree('qa')).toBe(true);
  });

  it('respects DEVPANEL_WORKTREES_ENABLED=false escape hatch', async () => {
    process.env.DEVPANEL_WORKTREES_ENABLED = 'false';
    captureExec();
    const { shouldUseWorktree } = await import('../../src/worker/worktree.js');
    expect(shouldUseWorktree('builder')).toBe(false);
  });
});

describe('worktree — deriveBranch', () => {
  it('uses Plane sequence + identifier when present', async () => {
    captureExec();
    const { __internal } = await import('../../src/worker/worktree.js');
    const branch = __internal.deriveBranch({
      sequenceId: 144,
      projectIdentifier: 'DEVPA',
      title: 'Worker has no per-job git worktree isolation'
    });
    expect(branch).toBe('feat/DEVPA-144-worker-has-no-per-job-git-worktr');
  });

  it('falls back to UUID prefix when sequence missing', async () => {
    captureExec();
    const { __internal } = await import('../../src/worker/worktree.js');
    const branch = __internal.deriveBranch({
      workItemId: '228066cb-b565-473c-8efc-0bfb1a94919b',
      title: 'add foo'
    });
    expect(branch).toBe('feat/wi-228066cb-add-foo');
  });

  it('uses a safe default when nothing identifiable is provided', async () => {
    captureExec();
    const { __internal } = await import('../../src/worker/worktree.js');
    expect(__internal.deriveBranch({})).toBe('feat/job-work');
  });

  // Synthetic work item IDs from webhooks-github.js look like
  // `github:owner/repo#42` and contain `:` `/` `#`, which are illegal in
  // git refs. The previous slice-only path produced unusable branches like
  // `feat/wi-github:E-…` that broke jobs 1581/1605/1607/1609 in prod.
  it('slugifies synthetic ids that contain illegal git ref characters', async () => {
    captureExec();
    const { __internal } = await import('../../src/worker/worktree.js');
    const branch = __internal.deriveBranch({
      workItemId: 'github:EpitechAfrik/Zeno#45',
      title: 'feat: sonde parent student activity'
    });
    // Must contain only [a-zA-Z0-9/_-]; no `:` `#` `/` outside the leading
    // namespace component.
    expect(branch).toMatch(/^feat\/wi-[a-z0-9-]+-[a-z0-9-]+$/);
    expect(branch).not.toMatch(/[:#]/);
    // Track exact value so any future drift is loud.
    expect(branch).toBe('feat/wi-github-epite-feat-sonde-parent-student-activi');
  });
});

describe('worktree — prepareWorktree', () => {
  it('returns null and runs no git commands for non-coding agents', async () => {
    const calls = captureExec();
    const { prepareWorktree } = await import('../../src/worker/worktree.js');
    const wt = await prepareWorktree('job-1', { agent: 'pm' });
    expect(wt).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('creates a fresh branch off origin/main when the branch does not exist', async () => {
    const calls = captureExec();
    const { prepareWorktree } = await import('../../src/worker/worktree.js');
    const wt = await prepareWorktree('job-42', {
      agent: 'builder',
      sequenceId: 144,
      projectIdentifier: 'DEVPA',
      workItem: { title: 'worktree iso' }
    });
    expect(wt).not.toBeNull();
    expect(wt.branch).toBe('feat/DEVPA-144-worktree-iso');
    expect(wt.path).toMatch(/worktrees\/job-42$/);

    const cmds = calls.map(c => c.cmd);
    expect(cmds.some(c => c.startsWith('git fetch origin main'))).toBe(true);
    expect(cmds.some(c => c.includes('worktree add -b "feat/DEVPA-144-worktree-iso"'))).toBe(true);
    expect(cmds.some(c => c.includes('"origin/main"'))).toBe(true);
  });

  it('reclaims a stale same-jobId slot left behind by a prior attempt', async () => {
    // Path exists AND git knows about it → previous attempt of this exact
    // jobId got SIGTERM'd before cleanup. Single-worker invariant means the
    // prior occupant is dead, safe to force-remove.
    const calls = [];
    vi.doMock('child_process', () => ({
      execSync: vi.fn((cmd) => {
        calls.push(cmd);
        if (cmd.includes('worktree list --porcelain')) {
          return [
            'worktree /repo',
            'HEAD abc123',
            'branch refs/heads/main',
            '',
            // The slot we're about to claim, owned by a dead prior attempt
            `worktree ${join(process.env.DEVPANEL_WORKTREES, 'job-77')}`,
            'HEAD def456',
            'branch refs/heads/feat/X-1-t',
            ''
          ].join('\n');
        }
        if (cmd.includes('rev-parse --verify')) {
          const err = new Error('not found'); err.status = 128; throw err;
        }
        return '';
      })
    }));
    const { prepareWorktree, __internal } = await import('../../src/worker/worktree.js');
    const path = join(__internal.WORKTREES_BASE, 'job-77');
    await fs.mkdir(path, { recursive: true });
    const wt = await prepareWorktree('job-77', {
      agent: 'builder',
      sequenceId: 1, projectIdentifier: 'X', workItem: { title: 't' }
    });
    expect(wt).not.toBeNull();
    // Reclaim ran on the existing path before the new add.
    const removeCall = calls.find(c => c.includes(`worktree remove --force "${path}"`));
    expect(removeCall).toBeDefined();
    expect(calls.indexOf(removeCall)).toBeLessThan(
      calls.findIndex(c => c.includes('worktree add'))
    );
  });

  it('removes an orphan directory with no git record before adding', async () => {
    // Path exists on disk but git doesn't know about it (partial-failure
    // leftover). Drop the bare dir and continue; rm via fs.rmSync, no
    // `worktree remove` call (git would refuse — it's not a worktree).
    const calls = [];
    vi.doMock('child_process', () => ({
      execSync: vi.fn((cmd) => {
        calls.push(cmd);
        if (cmd.includes('worktree list --porcelain')) {
          return 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n';
        }
        if (cmd.includes('rev-parse --verify')) {
          const err = new Error('not found'); err.status = 128; throw err;
        }
        return '';
      })
    }));
    const { prepareWorktree, __internal } = await import('../../src/worker/worktree.js');
    const path = join(__internal.WORKTREES_BASE, 'job-orphan');
    await fs.mkdir(path, { recursive: true });
    await fs.writeFile(join(path, 'leftover.txt'), 'stale');
    const wt = await prepareWorktree('job-orphan', {
      agent: 'builder',
      sequenceId: 2, projectIdentifier: 'X', workItem: { title: 't' }
    });
    expect(wt).not.toBeNull();
    // The dir was rm'd by fs (not by git) before the add.
    await expect(fs.access(join(path, 'leftover.txt'))).rejects.toThrow();
    expect(calls.some(c => c.includes(`worktree remove --force "${path}"`))).toBe(false);
  });

  it('reclaims a stale worktree pinned to the target branch', async () => {
    // Path is fresh, but the branch is attached to a dead sibling worktree
    // (canary 2080→2088 case). We should detect and force-remove the
    // sibling before `worktree add`, otherwise git fails with
    // "'feat/X-1-t' is already used by worktree at ...".
    const calls = [];
    const sibling = '/storage/worktrees/dead-sibling';
    vi.doMock('child_process', () => ({
      execSync: vi.fn((cmd) => {
        calls.push(cmd);
        if (cmd.includes('worktree list --porcelain')) {
          return [
            'worktree /repo', 'HEAD abc', 'branch refs/heads/main', '',
            `worktree ${sibling}`,
            'HEAD def',
            'branch refs/heads/feat/X-1-t',
            ''
          ].join('\n');
        }
        if (cmd.includes('rev-parse --verify')) {
          const err = new Error('not found'); err.status = 128; throw err;
        }
        return '';
      })
    }));
    const { prepareWorktree } = await import('../../src/worker/worktree.js');
    const wt = await prepareWorktree('job-fresh', {
      agent: 'builder',
      sequenceId: 1, projectIdentifier: 'X', workItem: { title: 't' }
    });
    expect(wt).not.toBeNull();
    const reclaimIdx = calls.findIndex(c => c.includes(`worktree remove --force "${sibling}"`));
    const addIdx = calls.findIndex(c => c.includes('worktree add'));
    expect(reclaimIdx).toBeGreaterThan(-1);
    expect(reclaimIdx).toBeLessThan(addIdx);
  });

  it('uses an explicit branch override when provided (reviewer/qa reuse)', async () => {
    const calls = captureExec();
    const { prepareWorktree } = await import('../../src/worker/worktree.js');
    const wt = await prepareWorktree('job-99', {
      agent: 'reviewer',
      branch: 'feat/DEVPA-144-existing'
    });
    expect(wt.branch).toBe('feat/DEVPA-144-existing');
    expect(calls.some(c => c.cmd.includes('worktree add -b "feat/DEVPA-144-existing"'))).toBe(true);
  });

  it('wipes a stale local branch when re-deriving for builder, then recreates off origin/main', async () => {
    // Canary 2122 (2026-05-08): worker on commit X, but a local branch
    // `feat/wi-...` from a prior failed builder attempt still pointed to
    // commit X-1. Without the wipe, prepareWorktree silently checked out
    // the stale commit; the verifier then saw a misleading "real" diff
    // (mostly negative reverts) and let the job through. Test that for a
    // DERIVED branch (no opts.branch), an existing local ref triggers
    // `branch -D` and the worktree-add takes the `-b ... origin/main` path.
    const calls = [];
    vi.doMock('child_process', () => ({
      execSync: vi.fn((cmd) => {
        calls.push({ cmd });
        if (cmd.includes('worktree list --porcelain')) {
          return 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n';
        }
        if (cmd.includes('rev-parse --verify --quiet "refs/heads/')) {
          // Branch DOES exist locally — simulate the stale-leftover case.
          return '';
        }
        if (cmd.includes('rev-parse --verify --quiet "refs/remotes/origin/')) {
          const err = new Error('not found'); err.status = 128; throw err;
        }
        return '';
      })
    }));
    const { prepareWorktree } = await import('../../src/worker/worktree.js');
    const wt = await prepareWorktree('job-stale-branch', {
      agent: 'builder',
      sequenceId: 155, projectIdentifier: 'DEVPA',
      workItem: { title: 'add storybook' }
    });
    expect(wt).not.toBeNull();
    // The branch -D fired before the worktree add.
    const deleteIdx = calls.findIndex(c => c.cmd.includes(`branch -D "feat/DEVPA-155-add-storybook"`));
    const addIdx = calls.findIndex(c => c.cmd.startsWith('git worktree add -b'));
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeLessThan(addIdx);
    // And we DID take the `-b ... origin/main` path (not the `add <path> <branch>` path).
    expect(calls.some(c => c.cmd.includes('worktree add -b "feat/DEVPA-155-add-storybook"') && c.cmd.includes('"origin/main"'))).toBe(true);
  });

  it('does NOT wipe a local branch when caller passed opts.branch (reviewer/qa retreat)', async () => {
    // Reviewer/QA on retreat passes the builder's branch explicitly. That
    // branch is the WORK — wiping it would lose the builder's commits.
    const calls = [];
    vi.doMock('child_process', () => ({
      execSync: vi.fn((cmd) => {
        calls.push({ cmd });
        if (cmd.includes('worktree list --porcelain')) {
          return 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n';
        }
        if (cmd.includes('rev-parse --verify --quiet "refs/heads/feat/builder-work"')) {
          return ''; // exists locally
        }
        if (cmd.includes('rev-parse --verify')) {
          const err = new Error('not found'); err.status = 128; throw err;
        }
        return '';
      })
    }));
    const { prepareWorktree } = await import('../../src/worker/worktree.js');
    const wt = await prepareWorktree('job-reviewer', {
      agent: 'reviewer',
      branch: 'feat/builder-work'
    });
    expect(wt.branch).toBe('feat/builder-work');
    // No branch -D should have fired.
    expect(calls.some(c => c.cmd.includes('branch -D'))).toBe(false);
    // Should have used the `worktree add <path> <branch>` form (existing branch).
    expect(calls.some(c => c.cmd.includes('worktree add "') && !c.cmd.includes(' -b '))).toBe(true);
  });

  it('runs git in the supplied repoRoot, not PROJECT_ROOT', async () => {
    const calls = captureExec();
    const { prepareWorktree } = await import('../../src/worker/worktree.js');
    const wt = await prepareWorktree('job-cross', {
      agent: 'builder',
      sequenceId: 42,
      projectIdentifier: 'ZENO',
      workItem: { title: 'cross repo' },
      repoRoot: '/home/deploy/projects/zeno'
    });
    expect(wt).not.toBeNull();
    // Every git command must run with cwd set to the cross-repo path. If
    // any execSync call lands in PROJECT_ROOT, builders would push commits
    // onto the wrong repo (the bug this test guards).
    for (const { opts } of calls) {
      expect(opts?.cwd).toBe('/home/deploy/projects/zeno');
    }
  });
});

describe('worktree — cleanupWorktree', () => {
  it('runs git worktree remove and never throws', async () => {
    const calls = captureExec();
    const { cleanupWorktree } = await import('../../src/worker/worktree.js');
    await cleanupWorktree('/tmp/some-path');
    const cmds = calls.map(c => c.cmd);
    expect(cmds.some(c => c.includes('worktree remove --force "/tmp/some-path"'))).toBe(true);
  });

  it('falls back to worktree prune on remove failure', async () => {
    const calls = [];
    vi.doMock('child_process', () => ({
      execSync: vi.fn((cmd) => {
        calls.push(cmd);
        if (cmd.includes('worktree remove')) {
          const err = new Error('not a working tree');
          err.status = 128;
          throw err;
        }
        return '';
      })
    }));
    const { cleanupWorktree } = await import('../../src/worker/worktree.js');
    await expect(cleanupWorktree('/tmp/missing')).resolves.toBeUndefined();
    expect(calls.some(c => c.includes('worktree prune'))).toBe(true);
  });

  it('is a no-op when path is empty', async () => {
    const calls = captureExec();
    const { cleanupWorktree } = await import('../../src/worker/worktree.js');
    await cleanupWorktree('');
    expect(calls).toHaveLength(0);
  });
});
