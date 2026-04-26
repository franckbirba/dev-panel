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

  it('throws if the worktree path already exists (no silent reuse)', async () => {
    captureExec();
    const { prepareWorktree, __internal } = await import('../../src/worker/worktree.js');
    const path = join(__internal.WORKTREES_BASE, 'job-77');
    await fs.mkdir(path, { recursive: true });
    await expect(prepareWorktree('job-77', {
      agent: 'builder',
      sequenceId: 1, projectIdentifier: 'X', workItem: { title: 't' }
    })).rejects.toThrow(/worktree path already exists/);
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
