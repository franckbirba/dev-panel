// tests/worker/engine-transitions.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

let createInstance, loadInstance, updateInstance, triggerNext;

const FLOWS = {
  'work-item': {
    name: 'work-item', max_revisions: 3, on_exhaustion: 'block',
    steps: [
      { agent: 'builder',  on: { done: { next: 'reviewer' },
                                 blocked: { next: 'pm', workflow: 'replan' },
                                 failed: { terminal: true } } },
      { agent: 'reviewer', retreat_allowed: ['builder'],
        on: { done: { next: 'qa' },
              blocked: { next: 'pm', workflow: 'replan' },
              failed: { next: 'builder', when: 'reviewer_rejected_pr' } } },
      { agent: 'qa', retreat_allowed: ['pm'],
        on: { done: { terminal: true },
              failed:  { next: 'pm', workflow: 'replan' },
              blocked: { next: 'pm', workflow: 'replan' } } }
    ]
  },
  replan: {
    name: 'replan', max_revisions: 1, on_exhaustion: 'block',
    steps: [{ agent: 'pm', on: { done: { terminal: true },
                                 blocked: { terminal: true },
                                 failed: { terminal: true } } }]
  }
};

beforeAll(async () => {
  await startPg();
  ({ createInstance, loadInstance, updateInstance } = await import('../../src/server/workflow-instances.js'));
  ({ triggerNext } = await import('../../src/worker/engine.js'));
}, 60000);

afterAll(async () => { await stopPg(); });

beforeEach(() => truncateOrchestration());

function fakeJob(agent, work_item_id, overrides = {}) {
  return {
    job_id: `j-${work_item_id}-${agent}`,
    agent,
    workflow: 'work-item',
    plane: { work_item_id, module_id: 'm1', cycle_id: 'c1' },
    ...overrides
  };
}

describe('triggerNext — forward transitions', () => {
  let enqueued;
  const enqueue = vi.fn(async (payload) => {
    enqueued.push(payload); return { id: `job-${enqueued.length}` };
  });

  beforeEach(() => { enqueued = []; enqueue.mockClear(); });

  it('builder.done → enqueues reviewer, updates instance.current_step', async () => {
    await createInstance({ work_item_id: 'wi-fwd1', workflow_name: 'work-item', current_step: 'builder' });
    await triggerNext({
      jobData: fakeJob('builder', 'wi-fwd1'),
      result: { status: 'done', summary: 'ok' },
      flows: FLOWS, enqueue
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].agent).toBe('reviewer');
    expect(enqueued[0].workflow).toBe('work-item');
    const inst = await loadInstance({ work_item_id: 'wi-fwd1', workflow_name: 'work-item' });
    expect(inst.current_step).toBe('reviewer');
    expect(inst.status).toBe('running');
  });

  it('qa.done → instance terminal, no enqueue', async () => {
    await createInstance({ work_item_id: 'wi-fwd2', workflow_name: 'work-item', current_step: 'qa' });
    await triggerNext({
      jobData: fakeJob('qa', 'wi-fwd2'),
      result: { status: 'done', summary: 'green' },
      flows: FLOWS, enqueue
    });
    expect(enqueued).toHaveLength(0);
    const inst = await loadInstance({ work_item_id: 'wi-fwd2', workflow_name: 'work-item' });
    expect(inst.status).toBe('done');
  });
});

describe('triggerNext — retreat allowlist', () => {
  const enqueue = vi.fn(async () => ({ id: 'x' }));

  it('reviewer emits handoff.next_agent=builder → retreat override applied', async () => {
    await createInstance({ work_item_id: 'wi-r1', workflow_name: 'work-item', current_step: 'reviewer' });
    enqueue.mockClear();
    await triggerNext({
      jobData: fakeJob('reviewer', 'wi-r1'),
      result: { status: 'failed', issues_found: [{ severity: 'p1' }] },
      flows: FLOWS, enqueue
    });
    // predicate also picks builder; retreat confirms same target
    const calls = enqueue.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].agent).toBe('builder');
  });

  it('reviewer emits handoff.next_agent=deploy → out of allowlist, rejected', async () => {
    await createInstance({ work_item_id: 'wi-r2', workflow_name: 'work-item', current_step: 'reviewer' });
    enqueue.mockClear();
    await triggerNext({
      jobData: fakeJob('reviewer', 'wi-r2'),
      result: { status: 'done', handoff: { next_agent: 'deploy' } },
      flows: FLOWS, enqueue
    });
    // declared transition done→qa wins
    expect(enqueue.mock.calls[0][0].agent).toBe('qa');
  });
});

describe('triggerNext — replan and revision guard', () => {
  const enqueue = vi.fn(async () => ({ id: 'x' }));

  it('qa.failed → enqueues pm replan with parent context, parent goes awaiting_approval', async () => {
    await createInstance({ work_item_id: 'wi-rp1', workflow_name: 'work-item', current_step: 'qa' });
    enqueue.mockClear();
    await triggerNext({
      jobData: fakeJob('qa', 'wi-rp1'),
      result: { status: 'failed', blockers: [{ kind: 'code', title: 'oops' }] },
      flows: FLOWS, enqueue
    });
    expect(enqueue.mock.calls).toHaveLength(1);
    const payload = enqueue.mock.calls[0][0];
    expect(payload.agent).toBe('pm');
    expect(payload.workflow).toBe('replan');
    expect(payload.parent_workflow).toBe('work-item');
    expect(payload.failed_step).toBe('qa');
    const parent = await loadInstance({ work_item_id: 'wi-rp1', workflow_name: 'work-item' });
    expect(parent.status).toBe('awaiting_approval');
  });

  it('revision cap reached → on_exhaustion=block, no enqueue', async () => {
    await createInstance({ work_item_id: 'wi-rp2', workflow_name: 'work-item', current_step: 'qa' });
    await updateInstance({ work_item_id: 'wi-rp2', workflow_name: 'work-item' }, { revision: 3 });
    enqueue.mockClear();
    await triggerNext({
      jobData: { ...fakeJob('qa', 'wi-rp2'), workflow_revision: 3 },
      result: { status: 'failed', blockers: [{ kind: 'code' }] },
      flows: FLOWS, enqueue
    });
    expect(enqueue.mock.calls).toHaveLength(0);
    const parent = await loadInstance({ work_item_id: 'wi-rp2', workflow_name: 'work-item' });
    expect(parent.status).toBe('exhausted');
    expect(Number(parent.exhausted_at)).toBeGreaterThan(0);
  });
});

describe('triggerNext — predicate gating', () => {
  const enqueue = vi.fn(async () => ({ id: 'x' }));

  it('reviewer.failed with no p1+ issue → predicate false, transition falls through to terminal', async () => {
    await createInstance({ work_item_id: 'wi-pred', workflow_name: 'work-item', current_step: 'reviewer' });
    enqueue.mockClear();
    await triggerNext({
      jobData: fakeJob('reviewer', 'wi-pred'),
      result: { status: 'failed', issues_found: [{ severity: 'p3' }] },
      flows: FLOWS, enqueue
    });
    expect(enqueue.mock.calls).toHaveLength(0);
    const parent = await loadInstance({ work_item_id: 'wi-pred', workflow_name: 'work-item' });
    expect(parent.status).toBe('failed');
  });
});

describe('triggerNext — replan resume', () => {
  const enqueue = vi.fn(async () => ({ id: 'x' }));

  it('replan pm.done → bumps parent revision and re-enqueues first step of parent workflow', async () => {
    await createInstance({ work_item_id: 'wi-rs1', workflow_name: 'work-item', current_step: 'qa' });
    const parentRow = await loadInstance({ work_item_id: 'wi-rs1', workflow_name: 'work-item' });
    await updateInstance({ work_item_id: 'wi-rs1', workflow_name: 'work-item' },
                   { status: 'awaiting_approval', revision: 1 });
    const replanId = await createInstance({
      work_item_id: 'wi-rs1', workflow_name: 'replan',
      current_step: 'pm',
      metadata: {
        parent_workflow: 'work-item',
        parent_revision: 1,
        parent_instance_id: parentRow.id
      }
    });
    enqueue.mockClear();
    await triggerNext({
      jobData: { job_id: 'jp', agent: 'pm', workflow: 'replan',
                 workflow_instance_id: replanId,
                 plane: { work_item_id: 'wi-rs1' } },
      result: { status: 'done', summary: 'replanned' },
      flows: FLOWS, enqueue
    });
    expect(enqueue.mock.calls).toHaveLength(1);
    expect(enqueue.mock.calls[0][0].agent).toBe('builder');
    expect(enqueue.mock.calls[0][0].workflow).toBe('work-item');
    expect(enqueue.mock.calls[0][0].workflow_revision).toBe(2);
    const parent = await loadInstance({ work_item_id: 'wi-rs1', workflow_name: 'work-item' });
    expect(parent.revision).toBe(2);
    expect(parent.status).toBe('running');
  });
});
