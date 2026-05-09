// Diff verifier — guards against goose × Qwen3 hallucinating status=done
// while leaving a clean worktree (canary 2108, DEVPA-155, 2026-05-08).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ORIGINAL_ENV = { ...process.env };

let workdir;
let wt;
async function makeWt(name) {
  const p = join(workdir, name);
  await fs.mkdir(p, { recursive: true });
  return p;
}

beforeEach(async () => {
  workdir = await fs.mkdtemp(join(tmpdir(), 'verifier-'));
  wt = await makeWt('default');
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
        context: { worktree_path: wt, branch: 'feat/y', default_branch: 'main' },
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
        context: { worktree_path: wt, branch: 'feat/z', default_branch: 'main' },
        work_item: { title: 'add storybook' }
      },
      result,
      startedAt: Date.now()
    });
    expect(result.status).toBe('blocked');
    expect(result.summary).toMatch(/\[verifier\] model claimed status=done but produced no diff/);
    expect(result.summary).toContain('Added storybook command and skill'); // original preserved
    expect(result.summary).toContain('Dirty files at verify time'); // worker-authored commit message
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].kind).toBe('no_diff');
    expect(result.blockers[0].dirty_files).toBe(3);
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
        context: { worktree_path: wt, branch: 'feat/empty', default_branch: 'main' },
        work_item: { title: 't' }
      },
      result,
      startedAt: Date.now()
    });
    expect(result.status).toBe('blocked');
    expect(result.summary).toContain('Worktree was clean — model produced no files at all');
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
          worktree_path: wt,
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
        context: { worktree_path: wt, branch: 'feat/gone' },
        work_item: { title: 't' }
      },
      result,
      startedAt: Date.now()
    });
    // We can't verify, so we don't change the status. Pipeline continues
    // with the model's claim; the operator gets a console warning.
    expect(result.status).toBe('done');
  });

  it('AUTO-COMMITS files_modified when model claimed done but forgot to commit', async () => {
    // The structural shift (2026-05-08): the worker is the commit authority.
    // Model returns status=done with files_modified=[a.js,b.js] and a clean
    // commit on the worktree side; the worker stages those files and runs
    // git commit on the model's behalf, then re-checks the diff.
    const calls = [];
    let diffCallCount = 0;
    vi.doMock('child_process', () => ({
      execSync: vi.fn((cmd, opts) => {
        calls.push({ cmd, cwd: opts?.cwd });
        if (cmd.includes('git diff --quiet')) {
          diffCallCount++;
          // First call (pre-commit): no diff. Second call (post-commit):
          // diff present (auto-commit succeeded).
          if (diffCallCount === 1) return '';
          const err = new Error('diff present');
          err.status = 1;
          throw err;
        }
        if (cmd.includes('git diff --stat')) return ' 2 files changed';
        if (cmd.includes('git status --porcelain')) return ' M src/a.js\n M src/b.js';
        if (cmd.startsWith('git add --')) return '';
        if (cmd.startsWith('git commit')) return '[feat/x abc123] ...';
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
    const result = {
      status: 'done',
      summary: 'Refactor a.js and b.js',
      memory_writes_count: 0,
      artifacts: {
        files_modified: ['src/a.js', 'src/b.js'],
        files_created: [],
        commits: [],
        branch: null,
        tests_passed: false,
        pr_url: null,
      }
    };
    await runAutomation({
      jobData: {
        job_id: 'jcommit', agent: 'builder',
        plane: { work_item_id: 'wi-c' },
        context: { worktree_path: wt, branch: 'feat/x', default_branch: 'main' },
        work_item: { title: 't' }
      },
      result,
      startedAt: Date.now()
    });
    // Status stays done because the post-commit diff check passed.
    expect(result.status).toBe('done');
    expect(result.summary).toBe('Refactor a.js and b.js'); // untouched
    // Verify the worker staged the claimed files and ran git commit.
    expect(calls.some(c => c.cmd.includes('git add --') && c.cmd.includes('src/a.js'))).toBe(true);
    expect(calls.some(c => c.cmd.includes('git add --') && c.cmd.includes('src/b.js'))).toBe(true);
    expect(calls.some(c => c.cmd === 'git commit -F -')).toBe(true);
  });

  it('does NOT auto-stage when manifest is empty even if worktree is dirty (no `git add -A`)', async () => {
    // Sweeping every dirty path with `git add -A` would commit unrelated
    // cruft (residue from a half-failed prior run, IDE files, OS junk) as if
    // it were the work item's diff. When the model returns an empty
    // manifest, we downgrade to blocked — replan is the right answer, not a
    // guess. See user feedback 2026-05-08.
    const calls = [];
    vi.doMock('child_process', () => ({
      execSync: vi.fn((cmd) => {
        calls.push(cmd);
        if (cmd.includes('git diff --quiet')) return ''; // exit 0 = no diff
        if (cmd.includes('git diff --stat')) return '';
        if (cmd.includes('git status --porcelain')) return '?? cruft.js\n M random.txt';
        return '';
      })
    }));
    vi.doMock('../../src/server/jobs-log.js', () => ({
      logStep: vi.fn(async () => {}), countMemoryWrites: vi.fn(async () => 0)
    }));
    vi.doMock('../../src/server/alerts.js', () => ({ notifyJob: vi.fn(async () => {}) }));
    vi.doMock('../../src/worker/engine.js', () => ({
      loadWorkflows: vi.fn(() => ({})), triggerNext: vi.fn(async () => ({}))
    }));
    vi.doMock('../../src/server/bullmq.js', () => ({
      getQueue: vi.fn(() => ({ add: vi.fn() })),
      QUEUES: { agents: 'q' }, PRIORITY_MAP: { p2: 10 }
    }));
    const { runAutomation } = await import('../../src/worker/automation.js');
    const result = {
      status: 'done', summary: 'I did the thing',
      memory_writes_count: 0,
      artifacts: { files_modified: [], files_created: [] }
    };
    await runAutomation({
      jobData: {
        job_id: 'jfb', agent: 'builder',
        plane: { work_item_id: 'wi-f' },
        context: { worktree_path: wt, branch: 'feat/f', default_branch: 'main' },
        work_item: { title: 't' }
      },
      result, startedAt: Date.now()
    });
    // Worker MUST NOT have run `git add -A` or `git add .` — that would
    // sweep up cruft.
    expect(calls.some(c => c === 'git add -A' || c === 'git add .')).toBe(false);
    // Worker MUST NOT have committed anything.
    expect(calls.some(c => c.startsWith('git commit'))).toBe(false);
    // Status downgraded to blocked because the manifest was empty.
    expect(result.status).toBe('blocked');
    expect(result.blockers[0].kind).toBe('no_diff');
    expect(result.blockers[0].files_claimed).toBe(0);
  });

  it('skips verification cleanly when worktree was already cleaned up (canary 2129)', async () => {
    // Reproduces the spawnSync ENOENT seen on canary 2129 (DEVPA-155,
    // 2026-05-08): builder's worktree is gone by the time runAutomation
    // calls the verifier. Without the existsSync guard, execSync's
    // {cwd:<missing>} causes Node to fail with ENOENT before the mocked
    // execSync ever runs. Guard short-circuits to a clean { changed:false,
    // error:'worktree_gone' } and leaves the result alone.
    const calls = [];
    vi.doMock('child_process', () => ({
      execSync: vi.fn((cmd) => {
        calls.push(cmd);
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
    const result = { status: 'done', summary: 'shipped', memory_writes_count: 0 };
    const missing = join(workdir, 'never-existed');
    await runAutomation({
      jobData: {
        job_id: 'j8', agent: 'builder',
        plane: { work_item_id: 'wi-8' },
        context: { worktree_path: missing, branch: 'feat/race', default_branch: 'main' },
        work_item: { title: 't' }
      },
      result,
      startedAt: Date.now()
    });
    expect(result.status).toBe('done'); // untouched
    // No git command was even attempted — the guard short-circuited first.
    expect(calls.filter(c => c.includes('git'))).toHaveLength(0);
  });
});
