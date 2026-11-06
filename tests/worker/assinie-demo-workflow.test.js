// tests/worker/assinie-demo-workflow.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

let createInstance, loadInstance, updateInstance, triggerNext;

const FLOWS = {
  'assinie-demo': {
    name: 'assinie-demo',
    description: 'Démo Assinie workflow with full-stack, ops and cybersecurity checks',
    max_revisions: 3,
    on_exhaustion: 'block',
    steps: [
      { agent: 'builder',
        on: { done: { next: 'cybersecurity' },
              blocked: { next: 'pm', workflow: 'replan' },
              failed: { terminal: true } } },
      { agent: 'cybersecurity', retreat_allowed: ['builder'],
        on: { done: { next: 'ops' },
              failed: { next: 'builder', when: 'security_issues_found' },
              blocked: { next: 'pm', workflow: 'replan' } } },
      { agent: 'ops', retreat_allowed: ['cybersecurity'],
        on: { done: { next: 'full-stack' },
              failed: { next: 'cybersecurity', when: 'ops_issues_found' },
              blocked: { next: 'pm', workflow: 'replan' } } },
      { agent: 'full-stack', retreat_allowed: ['ops'],
        on: { done: { next: 'reviewer' },
              failed: { next: 'ops', when: 'implementation_issues_found' },
              blocked: { next: 'pm', workflow: 'replan' } } },
      { agent: 'reviewer', retreat_allowed: ['full-stack'],
        on: { done: { next: 'qa' },
              failed: { next: 'full-stack', when: 'reviewer_rejected_pr' },
              blocked: { next: 'pm', workflow: 'replan' } } },
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
    workflow: 'assinie-demo',
    workflow_instance_id: work_item_id,
    workflow_revision: 1,
    work_item: { id: work_item_id },
    ...overrides
  };
}

describe('assinie-demo workflow transitions', () => {
  it('loads the workflow definition', async () => {
    const flow = await import('../../src/worker/workflows/assinie-demo.yaml');
    expect(flow.default).toMatchObject({
      name: 'assinie-demo',
      description: expect.stringContaining('Démo Assinie'),
      steps: expect.arrayContaining([
        expect.objectContaining({ agent: 'builder' }),
        expect.objectContaining({ agent: 'cybersecurity' }),
        expect.objectContaining({ agent: 'ops' }),
        expect.objectContaining({ agent: 'full-stack' }),
        expect.objectContaining({ agent: 'reviewer' }),
        expect.objectContaining({ agent: 'qa' })
      ])
    });
  });

  it('transitions from builder to cybersecurity on success', async () => {
    const inst = await createInstance(FLOWS['assinie-demo'], 'wi-123');
    const job = fakeJob('builder', 'wi-123', { status: 'done' });
    const next = await triggerNext(inst, job);
    expect(next).toEqual({
      agent: 'cybersecurity',
      workflow: 'assinie-demo',
      workflow_instance_id: 'wi-123',
      workflow_revision: 2
    });
  });

  it('transitions from cybersecurity to ops on success', async () => {
    const inst = await createInstance(FLOWS['assinie-demo'], 'wi-123');
    await updateInstance(inst.id, { current_step_index: 1 }); // Move to cybersecurity step
    const job = fakeJob('cybersecurity', 'wi-123', { status: 'done' });
    const next = await triggerNext(inst, job);
    expect(next).toEqual({
      agent: 'ops',
      workflow: 'assinie-demo',
      workflow_instance_id: 'wi-123',
      workflow_revision: 3
    });
  });

  it('transitions from ops to full-stack on success', async () => {
    const inst = await createInstance(FLOWS['assinie-demo'], 'wi-123');
    await updateInstance(inst.id, { current_step_index: 2 }); // Move to ops step
    const job = fakeJob('ops', 'wi-123', { status: 'done' });
    const next = await triggerNext(inst, job);
    expect(next).toEqual({
      agent: 'full-stack',
      workflow: 'assinie-demo',
      workflow_instance_id: 'wi-123',
      workflow_revision: 4
    });
  });

  it('transitions from full-stack to reviewer on success', async () => {
    const inst = await createInstance(FLOWS['assinie-demo'], 'wi-123');
    await updateInstance(inst.id, { current_step_index: 3 }); // Move to full-stack step
    const job = fakeJob('full-stack', 'wi-123', { status: 'done' });
    const next = await triggerNext(inst, job);
    expect(next).toEqual({
      agent: 'reviewer',
      workflow: 'assinie-demo',
      workflow_instance_id: 'wi-123',
      workflow_revision: 5
    });
  });

  it('allows retreat from cybersecurity to builder when security issues found', async () => {
    const inst = await createInstance(FLOWS['assinie-demo'], 'wi-123');
    await updateInstance(inst.id, { current_step_index: 1 }); // Move to cybersecurity step
    const job = fakeJob('cybersecurity', 'wi-123', { 
      status: 'failed',
      context: { retry_feedback: 'security_issues_found' }
    });
    const next = await triggerNext(inst, job);
    expect(next).toEqual({
      agent: 'builder',
      workflow: 'assinie-demo',
      workflow_instance_id: 'wi-123',
      workflow_revision: 2
    });
  });

  it('allows retreat from ops to cybersecurity when ops issues found', async () => {
    const inst = await createInstance(FLOWS['assinie-demo'], 'wi-123');
    await updateInstance(inst.id, { current_step_index: 2 }); // Move to ops step
    const job = fakeJob('ops', 'wi-123', { 
      status: 'failed',
      context: { retry_feedback: 'ops_issues_found' }
    });
    const next = await triggerNext(inst, job);
    expect(next).toEqual({
      agent: 'cybersecurity',
      workflow: 'assinie-demo',
      workflow_instance_id: 'wi-123',
      workflow_revision: 3
    });
  });

  it('allows retreat from full-stack to ops when implementation issues found', async () => {
    const inst = await createInstance(FLOWS['assinie-demo'], 'wi-123');
    await updateInstance(inst.id, { current_step_index: 3 }); // Move to full-stack step
    const job = fakeJob('full-stack', 'wi-123', { 
      status: 'failed',
      context: { retry_feedback: 'implementation_issues_found' }
    });
    const next = await triggerNext(inst, job);
    expect(next).toEqual({
      agent: 'ops',
      workflow: 'assinie-demo',
      workflow_instance_id: 'wi-123',
      workflow_revision: 4
    });
  });
});