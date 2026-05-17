// Engine context-isolation: per-spawn fields (worktree_path) MUST NOT
// propagate to the next agent's enqueue payload. Workflow-level fields
// (branch, default_branch, project_root, …) MUST.
//
// The bug class this guards: canary 2129 (DEVPA-155, 2026-05-08) — the
// next agent inherited the previous agent's worktree_path and the verifier
// crashed with spawnSync ENOENT on a path prepareWorktree had already
// reclaimed.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  vi.resetModules();
});

async function loadEngineWithMockedInstances({ workflowName = 'work-item', currentStep = 'builder' } = {}) {
  const calls = { updateInstance: [] };
  vi.doMock('../../src/server/workflow-instances.js', () => ({
    loadInstance: vi.fn(async () => ({
      id: 'inst-1',
      work_item_id: 'wi-1',
      workflow_name: workflowName,
      current_step: currentStep,
      revision: 0,
      status: 'running',
      metadata: null,
    })),
    createInstance: vi.fn(async () => 'child-inst'),
    updateInstance: vi.fn(async (...args) => { calls.updateInstance.push(args); }),
    loadInstanceById: vi.fn(async () => null),
  }));
  // Make a tiny ad-hoc workflow dir so loadWorkflows picks up our test flow
  // — avoids depending on real workflow YAMLs that may evolve.
  const flowDir = join(tmpdir(), `engine-test-flows-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(flowDir, { recursive: true });
  writeFileSync(join(flowDir, 'work-item.yaml'), `
name: work-item
max_revisions: 5
on_exhaustion: block
steps:
  - agent: builder
    on:
      done: { next: reviewer }
      blocked: { next: pm, workflow: replan }
      failed: { next: pm, workflow: replan }
  - agent: reviewer
    on:
      done: { next: qa, terminal: false }
      blocked: { next: pm, workflow: replan }
      failed: { next: pm, workflow: replan }
  - agent: qa
    on:
      done: { next: qa, terminal: true }
      blocked: { next: pm, workflow: replan }
      failed: { next: pm, workflow: replan }
`, 'utf8');
  const { loadWorkflows, triggerNext } = await import('../../src/worker/engine.js');
  const flows = loadWorkflows(flowDir);
  // Cleanup hook
  return {
    flows, triggerNext, calls,
    cleanup: () => { try { rmSync(flowDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  };
}

describe('engine.triggerNext — context isolation', () => {
  it('strips worktree_path from forwarded context on forward transition', async () => {
    const { flows, triggerNext, cleanup } = await loadEngineWithMockedInstances();
    const enqueue = vi.fn().mockResolvedValue({ id: 'next-job' });
    try {
      await triggerNext({
        jobData: {
          job_id: 'j1', agent: 'builder',
          workflow: 'work-item', workflow_revision: 0,
          plane: { work_item_id: 'wi-1' },
          work_item: { title: 't' },
          context: {
            worktree_path: '/tmp/builder-worktree-that-will-be-cleaned',
            branch: 'feat/wi-12345678-thing',
            default_branch: 'main',
            project_root: '/repo',
            github_issue_number: 42,
            // DEVPA-228: parent_context is caller-controlled inheritance for
            // the INITIAL dispatch only. Engine-driven forwards must strip it.
            parent_context: { parent_job_id: 'p1', thread_context: { messages: [] } },
          }
        },
        result: { status: 'done', summary: 'built', memory_writes_count: 0 },
        flows,
        enqueue
      });
      expect(enqueue).toHaveBeenCalledTimes(1);
      const payload = enqueue.mock.calls[0][0];
      expect(payload.agent).toBe('reviewer');
      // The whole point: worktree_path is gone.
      expect(payload.context).not.toHaveProperty('worktree_path');
      expect(payload.context).not.toHaveProperty('parent_context');
      // Workflow-level fields propagate.
      expect(payload.context.branch).toBe('feat/wi-12345678-thing');
      expect(payload.context.default_branch).toBe('main');
      expect(payload.context.project_root).toBe('/repo');
      expect(payload.context.github_issue_number).toBe(42);
    } finally {
      cleanup();
    }
  });

  it('strips worktree_path on retreat-to-replan as well', async () => {
    const { flows, triggerNext, cleanup } = await loadEngineWithMockedInstances({ currentStep: 'builder' });
    const enqueue = vi.fn().mockResolvedValue({ id: 'replan-job' });
    try {
      await triggerNext({
        jobData: {
          job_id: 'j2', agent: 'builder',
          workflow: 'work-item', workflow_revision: 0,
          plane: { work_item_id: 'wi-1' },
          work_item: { title: 't' },
          context: {
            worktree_path: '/tmp/dead-worktree',
            branch: 'feat/x',
            default_branch: 'main',
            parent_context: { parent_job_id: 'p2' },
          }
        },
        result: { status: 'blocked', summary: 'need clarification', memory_writes_count: 0, blockers: [] },
        flows,
        enqueue
      });
      expect(enqueue).toHaveBeenCalledTimes(1);
      const payload = enqueue.mock.calls[0][0];
      expect(payload.workflow).toBe('replan');
      expect(payload.context).not.toHaveProperty('worktree_path');
      expect(payload.context).not.toHaveProperty('parent_context');
      expect(payload.context.branch).toBe('feat/x');
    } finally {
      cleanup();
    }
  });
});
