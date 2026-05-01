// tests/worker/automation-triggerNext.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('runAutomation — workflow.trigger_next wiring', () => {
  let createInstance, loadInstance, runAutomation, __setEnqueueForTests;

  beforeAll(async () => {
    await startPg();
    ({ createInstance, loadInstance } = await import('../../src/server/workflow-instances.js'));
    ({ runAutomation, __setEnqueueForTests } = await import('../../src/worker/automation.js'));
  }, 60000);

  afterAll(async () => {
    await stopPg();
  });

  beforeEach(() => truncateOrchestration());

  it('job with no workflow field is a clean no-op for the engine', async () => {
    const enqueue = vi.fn();
    __setEnqueueForTests(enqueue);
    await runAutomation({
      jobData: { job_id: 'j-oneoff', agent: 'builder', plane: {}, work_item: {} },
      result: { status: 'done', summary: 'x', memory_writes_count: 0 },
      startedAt: Date.now() - 10
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('workflow job → engine enqueues next agent', async () => {
    await createInstance({ work_item_id: 'wi-A', workflow_name: 'work-item', current_step: 'builder' });
    const enqueue = vi.fn().mockResolvedValue({ id: 'new-job' });
    __setEnqueueForTests(enqueue);
    await runAutomation({
      jobData: {
        job_id: 'j-A', agent: 'builder',
        workflow: 'work-item', workflow_revision: 1,
        plane: { work_item_id: 'wi-A' }, work_item: { title: 't' }
      },
      result: { status: 'done', summary: 'built', memory_writes_count: 0 },
      startedAt: Date.now() - 10
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].agent).toBe('reviewer');
    const inst = await loadInstance({ work_item_id: 'wi-A', workflow_name: 'work-item' });
    expect(inst.current_step).toBe('reviewer');
  });

  // DEVPA-174: runAutomation used to swallow every step error, including the
  // workflow.trigger_next transition itself. That left workflow_instances
  // stuck in `running` forever — prod symptom on ZENO-238 was pm+builder
  // completed and reviewer/qa never enqueued. The fix marks the transition
  // step critical so BullMQ retries the job instead of completing it with a
  // silent drop.
  it('workflow.trigger_next propagates the error so BullMQ can retry', async () => {
    // No createInstance call → engine.triggerNext throws
    // "no workflow_instance for (wi-orphan, work-item)".
    const enqueue = vi.fn().mockResolvedValue({ id: 'never' });
    __setEnqueueForTests(enqueue);
    await expect(runAutomation({
      jobData: {
        job_id: 'j-orphan', agent: 'builder',
        workflow: 'work-item', workflow_revision: 1,
        plane: { work_item_id: 'wi-orphan' }, work_item: { title: 't' }
      },
      result: { status: 'done', summary: 'built', memory_writes_count: 0 },
      startedAt: Date.now() - 10
    })).rejects.toThrow(/no workflow_instance/);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
