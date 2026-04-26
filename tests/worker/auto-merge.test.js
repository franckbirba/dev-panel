// DEVPA-145 — autonomous merge after PR creation
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ORIGINAL_ENV = { ...process.env };
let workdir;
let modeFile;

beforeEach(async () => {
  workdir = await fs.mkdtemp(join(tmpdir(), 'merge-'));
  modeFile = join(workdir, '.shelly-mode.json');
  process.env = {
    ...ORIGINAL_ENV,
    MODE_FILE: modeFile,
    PROJECT_ROOT: workdir,
    GITHUB_TOKEN: 'gh_test_token'
  };
  vi.resetModules();
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  await fs.rm(workdir, { recursive: true, force: true });
});

function mockExec(handler) {
  vi.doMock('child_process', () => ({
    execSync: vi.fn(handler)
  }));
}

describe('automation — getShellyMode', () => {
  it('returns collaborative when MODE_FILE missing', async () => {
    mockExec(() => '');
    const { __testables } = await import('../../src/worker/automation.js');
    expect(__testables.getShellyMode()).toBe('collaborative');
  });

  it('reads autonomous from MODE_FILE', async () => {
    await fs.writeFile(modeFile, JSON.stringify({ mode: 'autonomous', since: '2026-04-26' }));
    mockExec(() => '');
    const { __testables } = await import('../../src/worker/automation.js');
    expect(__testables.getShellyMode()).toBe('autonomous');
  });

  it('falls back to collaborative on malformed JSON', async () => {
    await fs.writeFile(modeFile, '{not json');
    mockExec(() => '');
    const { __testables } = await import('../../src/worker/automation.js');
    expect(__testables.getShellyMode()).toBe('collaborative');
  });
});

describe('automation — autoMergePullRequest', () => {
  it('runs gh pr merge --squash --auto --delete-branch with the PR URL', async () => {
    const calls = [];
    mockExec((cmd, opts) => { calls.push({ cmd, opts }); return 'queued'; });
    const { __testables } = await import('../../src/worker/automation.js');
    const out = __testables.autoMergePullRequest({
      prUrl: 'https://github.com/franckbirba/dev-panel/pull/42',
      cwd: '/tmp/wt'
    });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toContain('gh pr merge');
    expect(calls[0].cmd).toContain('--squash');
    expect(calls[0].cmd).toContain('--auto');
    expect(calls[0].cmd).toContain('--delete-branch');
    expect(calls[0].cmd).toContain('"https://github.com/franckbirba/dev-panel/pull/42"');
    expect(calls[0].opts.cwd).toBe('/tmp/wt');
    expect(calls[0].opts.env.GH_TOKEN).toBe('gh_test_token');
  });

  it('returns ok=false with reason on failure (does not throw)', async () => {
    mockExec(() => {
      const err = new Error('not eligible');
      err.stderr = 'Auto-merge is not enabled for this repository';
      throw err;
    });
    const { __testables } = await import('../../src/worker/automation.js');
    const out = __testables.autoMergePullRequest({ prUrl: 'https://github.com/x/y/pull/1' });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('Auto-merge is not enabled');
  });

  it('treats already-merged as success (idempotent)', async () => {
    mockExec(() => {
      const err = new Error('boom');
      err.stderr = 'Pull request is already merged';
      throw err;
    });
    const { __testables } = await import('../../src/worker/automation.js');
    const out = __testables.autoMergePullRequest({ prUrl: 'https://github.com/x/y/pull/1' });
    expect(out.ok).toBe(true);
    expect(out.already_merged).toBe(true);
  });

  it('returns ok=false when no PR URL is supplied', async () => {
    mockExec(() => '');
    const { __testables } = await import('../../src/worker/automation.js');
    const out = __testables.autoMergePullRequest({ prUrl: null });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/no PR URL/);
  });
});
