// Diff verifier — guards against goose × Qwen3 hallucinating status=done
// while leaving a clean worktree (canary 2108, DEVPA-155, 2026-05-08).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ORIGINAL_ENV = { ...process.env };

let workdir;

beforeEach(async () => {
  workdir = await fs.mkdtemp(join(tmpdir(), 'verifier-'));
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  await fs.rm(workdir, { recursive: true, force: true });
});

// Mock execSync for git commands. Tests inject behavior per call:
//   diff --quiet exits 0 (no diff) by default
//   diff --quiet exits 1 (has diff) when configured
//   git status --porcelain returns whatever the test sets
function mockExec({ diffExit = 0, diffStat = '', porcelain = '' } = {}) {
  const calls = [];
  vi.doMock('child_process', () => ({
    execSync: vi.fn((cmd, opts) => {
      calls.push({ cmd, cwd: opts?.cwd });
      if (cmd.includes('git diff --quiet')) {
        if (diffExit !== 0) {
          const err = new Error('diff present');
          err.status = diffExit;
          throw err;
        }
        return '';
      }
      if (cmd.includes('git diff --stat')) return diffStat;
      if (cmd.includes('git status --porcelain')) return porcelain;
      return '';
    })
  }));
  return calls;
}

async function loadAutomation() {
  // Stub all the side-effect imports so we can exercise runAutomation
  // without a real DB / queue / fetch.
  vi.doMock('../../src/server/jobs-log.js', () => ({
    logStep: vi.fn(async () => {}),
    countMemoryWrites: vi.fn(async () => 0)
  }));
  vi.doMock('../../src/server/alerts.js', () => ({
    notifyJob: vi.fn(async () => {})
  }));
  vi.doMock('../../src/worker/engine.js', () => ({
    loadWorkflows: vi.fn(() => ({})),
    triggerNext: vi.fn(async () => ({ action: 'no-workflow' }))
  }));
  vi.doMock('../../src/server/bullmq.js', () => ({
    getQueue: vi.fn(() => ({ add: vi.fn(async () => ({ id: 'job-mock' })) })),
    QUEUES: { agents: 'devpanel-agents' },
    PRIORITY_MAP: { p2: 10 }
  }));
  return import('../../src/worker/automation.js');
}

describe('verifyDiffOrDowngrade — exposed via runAutomation', () => {
  it('does NOT downgrade when status≠done (passes blocked/failed through)', async () => {
    mockExec({ diffExit: 0 }); // even if diff verifier ran, would say no diff
    const { runAutomation } = await loadAutomation();
    const result = { status: 'blocked', summary: 'needed clarification', memory_writes_count: 0 };
    await runAutomation({
      jobData: {
        job_id: 'j1', agent: 'builder',
        plane: { work_item_id: 'wi-1' },
        context: { worktree_path: '/wt/1', branch: 'feat/x' },
        work_item: { title: 't' }
      },
      result,
      startedAt: Date.now()
    });
    expect(result.status).toBe('blocked');
    expect(result.summary).toBe('needed clarification'); // untouched
  });

  it('does NOT downgrade when there is no worktree (non-coding agent)', async () => {
    mockExec({ diffExit: 0 });
    const { runAutomation } = await loadAutomation();
    const result = { status: 'done', summary: 'planned', memory_writes_count: 0 };
    await runAutomation({
      jobData: {
        job_id: 'j2', agent: 'pm',
        plane: { work_item_id: 'wi-2' },
        context: {}, // no worktree_path/branch
        work_item: { title: 't' }
      },
      result,
      startedAt: Date.now()
    });
    expect(result.status).toBe('done'); // pm has no diff to verify
  });

  it('does NOT downgrade when status=done AND there is a real diff', async () => {
    mockExec({ diffExit: 1, diffStat: ' 3 files changed, 42 insertions(+)' });
    const { runAutomation } = await loadAutomation();
    const result = { status: 'done', summary: 'shipped feature', memory_writes_count: 0 };
    await runAutomation({
      jobData: {
        job_id: 'j3', agent: 'builder',
        plane: { work_item_id: 'wi-3' },
        context: { worktree_path: '/wt/3', branch: 'feat/y', default_branch: 'main' },
        work_item: { title: 't' }
      },
      result,
      startedAt: Date.now()
    });
    expect(result.status).toBe('done');
    expect(result.summary).toBe('shipped feature');
  });

  it('DOWNGRADES status=done to blocked when there is no diff (canary 2108 case)', async () => {
    mockExec({
      diffExit: 0,
      porcelain: '?? .claude/commands/devpanl-add-storybook.md\n?? .claude/skills/storybook-authoring.md\n?? test.txt'
    });
    const { runAutomation } = await loadAutomation();
    const result = {
      status: 'done',
      summary: 'Added storybook command and skill',
      memory_writes_count: 0,
      blockers: []
    };
    await runAutomation({
      jobData: {
        job_id: 'j4', agent: 'builder',
        plane: { work_item_id: 'wi-4' },
        context: { worktree_path: '/wt/4', branch: 'feat/z', default_branch: 'main' },
        work_item: { title: 'add storybook' }
      },
      result,
      startedAt: Date.now()
    });
    expect(result.status).toBe('blocked');
    expect(result.summary).toMatch(/\[verifier\] model claimed status=done but produced no diff/);
    expect(result.summary).toContain('Added storybook command and skill'); // original preserved
    expect(result.summary).toContain('Uncommitted/untracked files');
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].kind).toBe('no_diff');
    expect(result.blockers[0].uncommitted_files).toBe(3);
  });

  it('downgrades cleanly when worktree is empty (no diff, no untracked)', async () => {
    mockExec({ diffExit: 0, porcelain: '' });
    const { runAutomation } = await loadAutomation();
    const result = {
      status: 'done',
      summary: 'work complete',
      memory_writes_count: 0
    };
    await runAutomation({
      jobData: {
        job_id: 'j5', agent: 'builder',
        plane: { work_item_id: 'wi-5' },
        context: { worktree_path: '/wt/5', branch: 'feat/empty', default_branch: 'main' },
        work_item: { title: 't' }
      },
      result,
      startedAt: Date.now()
    });
    expect(result.status).toBe('blocked');
    expect(result.summary).toContain('Worktree is clean — model produced no files at all');
  });

  it('uses default_branch from context when present (cross-repo support)', async () => {
    const calls = mockExec({ diffExit: 1, diffStat: ' 1 file changed' });
    const { runAutomation } = await loadAutomation();
    const result = { status: 'done', summary: 'ok', memory_writes_count: 0 };
    await runAutomation({
      jobData: {
        job_id: 'j6', agent: 'builder',
        plane: { work_item_id: 'wi-6' },
        context: {
          worktree_path: '/wt/6',
          branch: 'feat/q',
          default_branch: 'develop' // not main
        },
        work_item: { title: 't' }
      },
      result,
      startedAt: Date.now()
    });
    // The diff command should have referenced origin/develop, not origin/main.
    expect(calls.some(c => c.cmd.includes('origin/develop'))).toBe(true);
    expect(result.status).toBe('done');
  });

  it('does NOT downgrade when git itself errors (worktree missing, etc.)', async () => {
    // status > 1 from git means real error, not just "diff present".
    const calls = [];
    vi.doMock('child_process', () => ({
      execSync: vi.fn((cmd) => {
        calls.push(cmd);
        if (cmd.includes('git diff --quiet')) {
          const err = new Error('not a git repository');
          err.status = 128;
          throw err;
        }
        return '';
      })
    }));
    vi.doMock('../../src/server/jobs-log.js', () => ({
      logStep: vi.fn(async () => {}), countMemoryWrites: vi.fn(async () => 0)
    }));
    vi.doMock('../../src/server/alerts.js', () => ({ notifyJob: vi.fn(async () => {}) }));
    vi.doMock('../../src/worker/engine.js', () => ({
      loadWorkflows: vi.fn(() => ({})),
      triggerNext: vi.fn(async () => ({ action: 'no-workflow' }))
    }));
    vi.doMock('../../src/server/bullmq.js', () => ({
      getQueue: vi.fn(() => ({ add: vi.fn() })),
      QUEUES: { agents: 'q' },
      PRIORITY_MAP: { p2: 10 }
    }));
    const { runAutomation } = await import('../../src/worker/automation.js');
    const result = { status: 'done', summary: 'ok', memory_writes_count: 0 };
    await runAutomation({
      jobData: {
        job_id: 'j7', agent: 'builder',
        plane: { work_item_id: 'wi-7' },
        context: { worktree_path: '/wt/gone', branch: 'feat/gone' },
        work_item: { title: 't' }
      },
      result,
      startedAt: Date.now()
    });
    // We can't verify, so we don't change the status. Pipeline continues
    // with the model's claim; the operator gets a console warning.
    expect(result.status).toBe('done');
  });
});
