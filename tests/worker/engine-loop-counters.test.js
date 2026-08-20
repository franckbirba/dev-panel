// tests/worker/engine-loop-counters.test.js
// ADR-006 §Décision 1/2 — the engine counts iterations PER declared loop
// (not just one anonymous global counter), exits early via `until`, and
// applies `on_exhaustion` per loop once `max_iterations` is hit.
//
// Uses loadWorkflows() (not hand-built flow literals) so `flow.graph` is
// populated exactly as it would be in production — that's what triggerNext
// consults for per-loop bookkeeping.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

let createInstance, loadInstance, updateInstance, triggerNext, loadWorkflows;

function writeGraphFlow(dir) {
  writeFileSync(join(dir, 'graph-flow.yaml'), `
name: graph-flow
nodes:
  - id: build
    agent: builder
  - id: review
    agent: reviewer
  - id: qa
    agent: qa
loops:
  - id: revision
    body: [build, review]
    until: review_done
    max_iterations: 2
    budget_tokens: 400000
    on_exhaustion: block
edges:
  - { from: build, on: done, to: review }
  - { from: review, on: failed, when: reviewer_rejected_pr, to: build }
  - { from: review, on: done, to: qa }
  - { from: qa, on: done, terminal: true }
`);
}

beforeAll(async () => {
  await startPg();
  ({ createInstance, loadInstance, updateInstance } = await import('../../src/server/workflow-instances.js'));
  ({ triggerNext, loadWorkflows } = await import('../../src/worker/engine.js'));
}, 60000);

afterAll(async () => { await stopPg(); });

beforeEach(() => truncateOrchestration());

function fakeJob(agent, work_item_id, workflow, overrides = {}) {
  return {
    job_id: `j-${work_item_id}-${agent}`,
    agent,
    workflow,
    plane: { work_item_id, module_id: 'm1', cycle_id: 'c1' },
    ...overrides
  };
}

d('triggerNext — per-loop iteration counting (graph format)', () => {
  let flows;
  const enqueue = vi.fn(async () => ({ id: 'x' }));

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-loopcount-'));
    writeGraphFlow(dir);
    flows = loadWorkflows(dir);
    enqueue.mockClear();
  });

  it('review.failed -> build increments the "revision" loop counter, stored in instance metadata', async () => {
    await createInstance({ work_item_id: 'wi-lc1', workflow_name: 'graph-flow', current_step: 'reviewer' });
    await triggerNext({
      jobData: fakeJob('reviewer', 'wi-lc1', 'graph-flow'),
      result: { status: 'failed', issues_found: [{ severity: 'p1' }] },
      flows, enqueue
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].agent).toBe('builder');
    const inst = await loadInstance({ work_item_id: 'wi-lc1', workflow_name: 'graph-flow' });
    const meta = JSON.parse(inst.metadata || '{}');
    expect(meta.loop_counters?.revision).toBe(1);
  });

  it('a forward move that leaves the loop body (review.done -> qa) does not touch the loop counter', async () => {
    await createInstance({ work_item_id: 'wi-lc2', workflow_name: 'graph-flow', current_step: 'reviewer' });
    await triggerNext({
      jobData: fakeJob('reviewer', 'wi-lc2', 'graph-flow'),
      result: { status: 'done' },
      flows, enqueue
    });
    expect(enqueue.mock.calls[0][0].agent).toBe('qa');
    const inst = await loadInstance({ work_item_id: 'wi-lc2', workflow_name: 'graph-flow' });
    const meta = JSON.parse(inst.metadata || '{}');
    expect(meta.loop_counters?.revision ?? 0).toBe(0);
  });

  it('hitting max_iterations on the loop applies on_exhaustion=block -> status exhausted, no enqueue', async () => {
    // Only the back-edge (review.failed -> build) closes the loop and
    // consumes budget; build.done -> review is plain forward traversal
    // into the loop and is not counted (see findLoopForTransition).
    // max_iterations: 2, so the loop tolerates 2 reviewer-rejections
    // (builder gets re-dispatched both times) and blocks on the 3rd.
    await createInstance({ work_item_id: 'wi-lc3', workflow_name: 'graph-flow', current_step: 'reviewer' });

    // Bounce 1/2.
    await triggerNext({
      jobData: fakeJob('reviewer', 'wi-lc3', 'graph-flow'),
      result: { status: 'failed', issues_found: [{ severity: 'p1' }] },
      flows, enqueue
    });
    let inst = await loadInstance({ work_item_id: 'wi-lc3', workflow_name: 'graph-flow' });
    expect(JSON.parse(inst.metadata || '{}').loop_counters?.revision).toBe(1);
    enqueue.mockClear();

    // builder re-does its pass, forwards to reviewer again (not counted).
    await triggerNext({
      jobData: fakeJob('builder', 'wi-lc3', 'graph-flow'),
      result: { status: 'done' },
      flows, enqueue
    });
    enqueue.mockClear();

    // Bounce 2/2 — right at max_iterations, still allowed.
    await triggerNext({
      jobData: fakeJob('reviewer', 'wi-lc3', 'graph-flow'),
      result: { status: 'failed', issues_found: [{ severity: 'p1' }] },
      flows, enqueue
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    inst = await loadInstance({ work_item_id: 'wi-lc3', workflow_name: 'graph-flow' });
    expect(JSON.parse(inst.metadata || '{}').loop_counters?.revision).toBe(2);
    enqueue.mockClear();

    await triggerNext({
      jobData: fakeJob('builder', 'wi-lc3', 'graph-flow'),
      result: { status: 'done' },
      flows, enqueue
    });
    enqueue.mockClear();

    // Bounce 3 — exceeds max_iterations (2). Blocked.
    await triggerNext({
      jobData: fakeJob('reviewer', 'wi-lc3', 'graph-flow'),
      result: { status: 'failed', issues_found: [{ severity: 'p1' }] },
      flows, enqueue
    });
    expect(enqueue).toHaveBeenCalledTimes(0);
    inst = await loadInstance({ work_item_id: 'wi-lc3', workflow_name: 'graph-flow' });
    expect(inst.status).toBe('exhausted');
  });

  it('two different work items on the same loop-bearing workflow keep independent counters', async () => {
    await createInstance({ work_item_id: 'wi-lc4a', workflow_name: 'graph-flow', current_step: 'reviewer' });
    await createInstance({ work_item_id: 'wi-lc4b', workflow_name: 'graph-flow', current_step: 'reviewer' });
    await triggerNext({
      jobData: fakeJob('reviewer', 'wi-lc4a', 'graph-flow'),
      result: { status: 'failed', issues_found: [{ severity: 'p1' }] },
      flows, enqueue
    });
    const a = await loadInstance({ work_item_id: 'wi-lc4a', workflow_name: 'graph-flow' });
    const b = await loadInstance({ work_item_id: 'wi-lc4b', workflow_name: 'graph-flow' });
    expect(JSON.parse(a.metadata || '{}').loop_counters?.revision).toBe(1);
    expect(JSON.parse(b.metadata || '{}').loop_counters?.revision ?? 0).toBe(0);
  });
});

d('triggerNext — legacy steps: workflows keep identical global-revision behavior', () => {
  const enqueue = vi.fn(async () => ({ id: 'x' }));
  let flows;

  beforeEach(() => {
    flows = loadWorkflows(); // real shipped work-item.yaml + replan.yaml etc.
    enqueue.mockClear();
  });

  it('reviewer.failed -> builder on legacy work-item.yaml still enqueues normally (no regression)', async () => {
    await createInstance({ work_item_id: 'wi-legacy1', workflow_name: 'work-item', current_step: 'reviewer' });
    await triggerNext({
      jobData: fakeJob('reviewer', 'wi-legacy1', 'work-item'),
      result: { status: 'failed', issues_found: [{ severity: 'p1' }] },
      flows, enqueue
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].agent).toBe('builder');
  });
});
