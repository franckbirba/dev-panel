// tests/worker/automation-triggerNext.test.js
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase } from '../../src/server/db.js';
import { createInstance, loadInstance } from '../../src/server/workflow-instances.js';
import { runAutomation, __setEnqueueForTests } from '../../src/worker/automation.js';

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-auto-'));
  initMasterDatabase(dir);
});

describe('runAutomation — workflow.trigger_next wiring', () => {
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
    createInstance({ work_item_id: 'wi-A', workflow_name: 'work-item', current_step: 'builder' });
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
    const inst = loadInstance({ work_item_id: 'wi-A', workflow_name: 'work-item' });
    expect(inst.current_step).toBe('reviewer');
  });
});
