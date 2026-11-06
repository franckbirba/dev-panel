// tests/worker/engine-high-risk.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('engine — high-risk label handling', () => {
  let createInstance, loadInstance, updateInstance, triggerNext;

  const MERGE_COORDINATOR_FLOW = {
    name: 'merge-coordinator', max_revisions: 1, on_exhaustion: 'block',
    steps: [{
      agent: 'merge-coordinator',
      on: {
        done: { terminal: true },
        blocked: { terminal: true },
        failed: { terminal: true }
      }
    }]
  };

  beforeAll(async () => {
    await startPg();
    ({ createInstance, loadInstance, updateInstance } = await import('../../src/server/workflow-instances.js'));
    ({ triggerNext } = await import('../../src/worker/engine.js'));
  }, 60000);

  afterAll(async () => {
    await stopPg();
  });

  beforeEach(() => truncateOrchestration());

  it('merge-coordinator workflow with high-risk labels sets status to awaiting_approval', async () => {
    // Create workflow instance
    const instanceId = await createInstance({
      work_item_id: 'wi-high-risk',
      workflow_name: 'merge-coordinator',
      current_step: 'merge-coordinator'
    });

    // Mock the checkHighRiskAndAwaitApproval function to simulate high-risk detection
    const mockCheckHighRisk = vi.spyOn(await import('../../src/server/workflow-instances.js'), 'checkHighRiskAndAwaitApproval');
    mockCheckHighRisk.mockImplementation(async () => true);

    // Execute triggerNext with high-risk context
    const result = await triggerNext({
      jobData: {
        job_id: 'j-high-risk',
        agent: 'merge-coordinator',
        workflow: 'merge-coordinator',
        workflow_instance_id: instanceId,
        plane: { work_item_id: 'wi-high-risk' },
        context: {
          labels: ['high-risk', 'migration']
        }
      },
      result: { status: 'done', summary: 'PR ready but high-risk', memory_writes_count: 0 },
      flows: { 'merge-coordinator': MERGE_COODINATOR_FLOW },
      enqueue: vi.fn()
    });

    // Verify the workflow was marked as awaiting approval
    expect(result.action).toBe('awaiting_approval');
    expect(result.reason).toBe('high-risk item requires manual review');

    // Verify the instance status was updated
    const instance = await loadInstance({ work_item_id: 'wi-high-risk', workflow_name: 'merge-coordinator' });
    expect(instance.status).toBe('awaiting_approval');

    mockCheckHighRisk.mockRestore();
  });

  it('merge-coordinator workflow without high-risk labels proceeds normally', async () => {
    // Create workflow instance
    const instanceId = await createInstance({
      work_item_id: 'wi-normal',
      workflow_name: 'merge-coordinator',
      current_step: 'merge-coordinator'
    });

    const enqueueMock = vi.fn().mockResolvedValue({ id: 'next-job' });

    // Execute triggerNext with normal context
    const result = await triggerNext({
      jobData: {
        job_id: 'j-normal',
        agent: 'merge-coordinator',
        workflow: 'merge-coordinator',
        workflow_instance_id: instanceId,
        plane: { work_item_id: 'wi-normal' },
        context: {
          labels: ['feature', 'enhancement']
        }
      },
      result: { status: 'done', summary: 'PR ready for merge', memory_writes_count: 0 },
      flows: { 'merge-coordinator': MERGE_COORDINATOR_FLOW },
      enqueue: enqueueMock
    });

    // Verify normal workflow execution
    expect(result.action).not.toBe('awaiting_approval');
    expect(enqueueMock).toHaveBeenCalled();

    // Verify the instance status is not awaiting_approval
    const instance = await loadInstance({ work_item_id: 'wi-normal', workflow_name: 'merge-coordinator' });
    expect(instance.status).not.toBe('awaiting_approval');
  });

  it('non-merge-coordinator workflows are unaffected by high-risk logic', async () => {
    const WORK_ITEM_FLOW = {
      name: 'work-item', max_revisions: 3, on_exhaustion: 'block',
      steps: [
        { agent: 'builder', on: { done: { next: 'reviewer' } } },
        { agent: 'reviewer', on: { done: { next: 'qa' } } },
        { agent: 'qa', on: { done: { terminal: true } } }
      ]
    };

    // Create workflow instance
    await createInstance({
      work_item_id: 'wi-test',
      workflow_name: 'work-item',
      current_step: 'builder'
    });

    const enqueueMock = vi.fn().mockResolvedValue({ id: 'next-job' });

    // Execute triggerNext for work-item workflow with high-risk labels
    const result = await triggerNext({
      jobData: {
        job_id: 'j-test',
        agent: 'builder',
        workflow: 'work-item',
        plane: { work_item_id: 'wi-test' },
        context: {
          labels: ['high-risk']
        }
      },
      result: { status: 'done', summary: 'built', memory_writes_count: 0 },
      flows: { 'work-item': WORK_ITEM_FLOW },
      enqueue: enqueueMock
    });

    // Verify normal workflow execution
    expect(result.action).toBe('next');
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'reviewer'
    }), {});
  });
});