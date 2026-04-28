// tests/worker/webhooks-github-dispatch.test.js
// Integration test: webhook → enqueueWorkflowStart for merge-coordinator.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('GitHub webhook → merge-coordinator dispatch', () => {
  let enqueueWorkflowStart, __setEnqueueForTests, loadInstance;

  beforeAll(async () => {
    await startPg();
    ({ loadInstance } = await import('../../src/server/workflow-instances.js'));
    ({ enqueueWorkflowStart, __setEnqueueForTests } = await import('../../src/worker/dispatch.js'));
  }, 60000);

  afterAll(async () => {
    await stopPg();
  });

  beforeEach(() => truncateOrchestration());

  it('dispatches merge-coordinator with synthetic work_item_id', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'mc-1' });
    __setEnqueueForTests(enqueue);

    const result = await enqueueWorkflowStart({
      workflow: 'merge-coordinator',
      plane: { work_item_id: 'github:franckbirba/dev-panel#17' },
      work_item: { title: 'Test PR' },
      context: {
        github: {
          repo: 'franckbirba/dev-panel',
          pr_number: 17,
          head_sha: 'abc123',
          branch: 'feat/test'
        }
      }
    });

    expect(result.ok).toBe(true);
    expect(Number(result.instance_id)).toBeGreaterThan(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].agent).toBe('merge-coordinator');
    expect(enqueue.mock.calls[0][0].workflow).toBe('merge-coordinator');
  });

  it('returns already_running on duplicate PR dispatch', async () => {
    __setEnqueueForTests(vi.fn().mockResolvedValue({ id: 'mc-2' }));

    const first = await enqueueWorkflowStart({
      workflow: 'merge-coordinator',
      plane: { work_item_id: 'github:franckbirba/dev-panel#42' }
    });
    expect(first.ok).toBe(true);

    const second = await enqueueWorkflowStart({
      workflow: 'merge-coordinator',
      plane: { work_item_id: 'github:franckbirba/dev-panel#42' }
    });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('already_running');
  });

  it('different PRs can run concurrently', async () => {
    __setEnqueueForTests(vi.fn().mockResolvedValue({ id: 'mc-3' }));

    const pr1 = await enqueueWorkflowStart({
      workflow: 'merge-coordinator',
      plane: { work_item_id: 'github:franckbirba/dev-panel#1' }
    });
    const pr2 = await enqueueWorkflowStart({
      workflow: 'merge-coordinator',
      plane: { work_item_id: 'github:franckbirba/dev-panel#2' }
    });

    expect(pr1.ok).toBe(true);
    expect(pr2.ok).toBe(true);
  });
});
