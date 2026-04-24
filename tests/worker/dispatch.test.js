// tests/worker/dispatch.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('enqueueWorkflowStart', () => {
  let loadInstance, enqueueWorkflowStart, __setEnqueueForTests;

  beforeAll(async () => {
    await startPg();
    ({ loadInstance } = await import('../../src/server/workflow-instances.js'));
    ({ enqueueWorkflowStart, __setEnqueueForTests } = await import('../../src/worker/dispatch.js'));
  }, 60000);

  afterAll(async () => {
    await stopPg();
  });

  beforeEach(() => truncateOrchestration());

  it('creates instance + enqueues first step of workflow', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'j-1' });
    __setEnqueueForTests(enqueue);
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-d1', module_id: 'm', cycle_id: 'c' },
      work_item: { title: 'x' }
    });
    expect(out.ok).toBe(true);
    expect(Number(out.instance_id)).toBeGreaterThan(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].agent).toBe('builder');
    expect(enqueue.mock.calls[0][0].workflow_revision).toBe(1);
    const inst = await loadInstance({ work_item_id: 'wi-d1', workflow_name: 'work-item' });
    expect(inst.status).toBe('running');
    expect(inst.current_step).toBe('builder');
  });

  it('duplicate dispatch on active instance returns { ok:false, error:"already_running" }', async () => {
    __setEnqueueForTests(vi.fn().mockResolvedValue({ id: 'j' }));
    await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-d2' }
    });
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-d2' }
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('already_running');
  });

  it('rejects unknown workflow', async () => {
    const out = await enqueueWorkflowStart({
      workflow: 'no-such-flow',
      plane: { work_item_id: 'wi-d3' }
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/unknown workflow/);
  });

  it('rolls back the instance to failed when enqueue throws', async () => {
    __setEnqueueForTests(vi.fn().mockRejectedValue(new Error('redis down')));
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-rollback' }
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/enqueue_failed/);
    // The row should now be 'failed', so a follow-up dispatch can land fresh.
    __setEnqueueForTests(vi.fn().mockResolvedValue({ id: 'retry-1' }));
    const retry = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-rollback' }
    });
    expect(retry.ok).toBe(true);
    expect(Number(retry.instance_id)).toBeGreaterThan(0);
  });
});
