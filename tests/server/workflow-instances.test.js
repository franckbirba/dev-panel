// tests/server/workflow-instances.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase } from '../../src/server/db.js';
import {
  createInstance, loadInstance, updateInstance,
  listActive, listByCycle
} from '../../src/server/workflow-instances.js';

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-wi-'));
  initMasterDatabase(dir);
});

describe('workflow-instances', () => {
  it('creates an instance and loads it by (work_item_id, workflow_name)', () => {
    const id = createInstance({
      work_item_id: 'wi-1', workflow_name: 'work-item',
      current_step: 'builder', module_id: 'mod-1', cycle_id: 'cyc-1'
    });
    const row = loadInstance({ work_item_id: 'wi-1', workflow_name: 'work-item' });
    expect(row.id).toBe(id);
    expect(row.status).toBe('running');
    expect(row.revision).toBe(1);
    expect(row.current_step).toBe('builder');
  });

  it('rejects a duplicate active instance on the same (work_item, workflow)', () => {
    createInstance({ work_item_id: 'wi-2', workflow_name: 'work-item', current_step: 'builder' });
    expect(() =>
      createInstance({ work_item_id: 'wi-2', workflow_name: 'work-item', current_step: 'builder' })
    ).toThrow(/UNIQUE/);
  });

  it('allows a new instance once the prior one is terminal', () => {
    createInstance({ work_item_id: 'wi-3', workflow_name: 'work-item', current_step: 'builder' });
    updateInstance({ work_item_id: 'wi-3', workflow_name: 'work-item' },
                   { status: 'done' });
    const id2 = createInstance({ work_item_id: 'wi-3', workflow_name: 'work-item', current_step: 'builder' });
    expect(id2).toBeGreaterThan(0);
    // Flip the recreated wi-3 to done so the later 'lists active instances'
    // assertion (which expects wi-3 absent) is consistent.
    updateInstance({ work_item_id: 'wi-3', workflow_name: 'work-item' },
                   { status: 'done' });
  });

  it('updates current_step, revision, status, last_event_at', () => {
    createInstance({ work_item_id: 'wi-4', workflow_name: 'work-item', current_step: 'builder' });
    updateInstance({ work_item_id: 'wi-4', workflow_name: 'work-item' },
                   { current_step: 'reviewer', revision: 2 });
    const row = loadInstance({ work_item_id: 'wi-4', workflow_name: 'work-item' });
    expect(row.current_step).toBe('reviewer');
    expect(row.revision).toBe(2);
    expect(row.last_event_at).toBeGreaterThanOrEqual(row.started_at);
  });

  it('lists active instances', () => {
    const rows = listActive();
    const ids = rows.map(r => r.work_item_id);
    expect(ids).toContain('wi-1');
    expect(ids).not.toContain('wi-3'); // wi-3 was flipped to done before wi-3 recreate
  });

  it('lists instances by cycle_id', () => {
    createInstance({ work_item_id: 'wi-c', workflow_name: 'work-item', current_step: 'builder', cycle_id: 'cyc-X' });
    const rows = listByCycle('cyc-X');
    expect(rows.some(r => r.work_item_id === 'wi-c')).toBe(true);
  });
});
