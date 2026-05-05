// tests/worker/dispatch.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('enqueueWorkflowStart', () => {
  let loadInstance, enqueueWorkflowStart, __setEnqueueForTests;
  let initMasterDatabase, createProject;

  beforeAll(async () => {
    await startPg();
    ({ loadInstance } = await import('../../src/server/workflow-instances.js'));
    ({ enqueueWorkflowStart, __setEnqueueForTests } = await import('../../src/worker/dispatch.js'));
    ({ initMasterDatabase, createProject } = await import('../../src/server/db.js'));
    const tmp = mkdtempSync(join(tmpdir(), 'dispatch-'));
    initMasterDatabase(tmp);
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

  it('resolves project_root from plane.project_id and puts it on context', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'j-pr' });
    __setEnqueueForTests(enqueue);
    const planeId = 'plane-zeno-uuid';
    createProject({ name: `zeno-${Date.now()}`,
                    plane_project_id: planeId,
                    local_path: '/home/deploy/projects/zeno' });
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-pr1', project_id: planeId },
      work_item: { title: 'cross-repo dispatch' }
    });
    expect(out.ok).toBe(true);
    expect(enqueue.mock.calls[0][0].context.project_root).toBe('/home/deploy/projects/zeno');
  });

  it('caller-supplied context.project_root wins over the lookup', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'j-pr2' });
    __setEnqueueForTests(enqueue);
    const planeId = 'plane-edms-uuid';
    createProject({ name: `edms-${Date.now()}`,
                    plane_project_id: planeId,
                    local_path: '/home/deploy/projects/edms' });
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-pr2', project_id: planeId },
      work_item: { title: 'override' },
      context: { project_root: '/tmp/override' }
    });
    expect(out.ok).toBe(true);
    expect(enqueue.mock.calls[0][0].context.project_root).toBe('/tmp/override');
  });

  it('refuses to enqueue when plane.project_id is set but no project matches', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'j-pr3' });
    __setEnqueueForTests(enqueue);
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-pr3', project_id: 'unknown-plane-id' },
      work_item: { title: 'no project' }
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('project_not_linked');
    expect(out.message).toMatch(/unknown-plane-id/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('still enqueues when plane.project_id is omitted entirely (legacy ad-hoc dispatches)', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'j-pr4' });
    __setEnqueueForTests(enqueue);
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-pr4' },
      work_item: { title: 'no project_id' }
    });
    expect(out.ok).toBe(true);
    expect(enqueue.mock.calls[0][0].context.project_root).toBeUndefined();
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
