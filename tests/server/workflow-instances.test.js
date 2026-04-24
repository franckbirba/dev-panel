// tests/server/workflow-instances.test.js
// Integration coverage for workflow-instances against a throwaway Postgres.
// Skipped when docker is unavailable.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('workflow-instances', () => {
  let wi;

  beforeAll(async () => {
    await startPg();
    wi = await import('../../src/server/workflow-instances.js');
  }, 60000);

  afterAll(async () => {
    await stopPg();
  });

  beforeEach(() => truncateOrchestration());

  it('creates + loads', async () => {
    const id = await wi.createInstance({
      work_item_id: 'wi-1', workflow_name: 'work-item',
      current_step: 'builder', module_id: 'mod-1', cycle_id: 'cyc-1'
    });
    const row = await wi.loadInstance({ work_item_id: 'wi-1', workflow_name: 'work-item' });
    expect(Number(row.id)).toBe(Number(id));
    expect(row.status).toBe('running');
    expect(row.revision).toBe(1);
    expect(row.current_step).toBe('builder');
  });

  it('partial unique index rejects a duplicate active instance', async () => {
    await wi.createInstance({ work_item_id: 'wi-2', workflow_name: 'work-item', current_step: 'builder' });
    await expect(
      wi.createInstance({ work_item_id: 'wi-2', workflow_name: 'work-item', current_step: 'builder' })
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('terminal row frees the slot for a new instance', async () => {
    await wi.createInstance({ work_item_id: 'wi-3', workflow_name: 'work-item', current_step: 'builder' });
    await wi.updateInstance({ work_item_id: 'wi-3', workflow_name: 'work-item' }, { status: 'done' });
    const id2 = await wi.createInstance({ work_item_id: 'wi-3', workflow_name: 'work-item', current_step: 'builder' });
    expect(Number(id2)).toBeGreaterThan(0);
  });

  it('updateInstance patches only provided fields; exhausted sets exhausted_at', async () => {
    await wi.createInstance({ work_item_id: 'wi-4', workflow_name: 'work-item', current_step: 'builder' });
    await wi.updateInstance({ work_item_id: 'wi-4', workflow_name: 'work-item' },
      { current_step: 'reviewer', revision: 2 });
    let row = await wi.loadInstance({ work_item_id: 'wi-4', workflow_name: 'work-item' });
    expect(row.current_step).toBe('reviewer');
    expect(row.revision).toBe(2);
    expect(Number(row.last_event_at)).toBeGreaterThanOrEqual(Number(row.started_at));

    await wi.updateInstance({ work_item_id: 'wi-4', workflow_name: 'work-item' },
      { status: 'exhausted' });
    row = await wi.loadInstance({ work_item_id: 'wi-4', workflow_name: 'work-item' });
    expect(row.status).toBe('exhausted');
    expect(Number(row.exhausted_at)).toBeGreaterThan(0);
    // Non-patched fields preserved:
    expect(row.current_step).toBe('reviewer');
    expect(row.revision).toBe(2);
  });

  it('metadata round-trips as JSON string for callers', async () => {
    await wi.createInstance({
      work_item_id: 'wi-meta', workflow_name: 'replan', current_step: 'pm',
      metadata: { parent_instance_id: 42, failed_step: 'qa' }
    });
    const row = await wi.loadInstance({ work_item_id: 'wi-meta', workflow_name: 'replan' });
    expect(typeof row.metadata).toBe('string');
    const parsed = JSON.parse(row.metadata);
    expect(parsed.parent_instance_id).toBe(42);
    expect(parsed.failed_step).toBe('qa');
  });

  it('listActive + listByCycle filter correctly', async () => {
    await wi.createInstance({ work_item_id: 'wi-a', workflow_name: 'work-item', current_step: 'builder', cycle_id: 'cyc-X' });
    await wi.createInstance({ work_item_id: 'wi-t', workflow_name: 'work-item', current_step: 'builder', cycle_id: 'cyc-X' });
    await wi.updateInstance({ work_item_id: 'wi-t', workflow_name: 'work-item' }, { status: 'done' });
    const active = await wi.listActive();
    const activeIds = active.map(r => r.work_item_id);
    expect(activeIds).toContain('wi-a');
    expect(activeIds).not.toContain('wi-t');

    const byCycle = await wi.listByCycle('cyc-X');
    const cycleIds = byCycle.map(r => r.work_item_id);
    expect(cycleIds).toEqual(expect.arrayContaining(['wi-a', 'wi-t']));
  });

  it('updateInstance on a missing pair throws', async () => {
    await expect(
      wi.updateInstance({ work_item_id: 'nope', workflow_name: 'work-item' }, { status: 'failed' })
    ).rejects.toThrow(/no instance for/);
  });
});
