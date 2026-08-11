// tests/worker/reaper.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  listRunningInstancesMock: vi.fn(),
  updateInstanceMock: vi.fn(),
  getJobMock: vi.fn(),
  memoryInsertMock: vi.fn(),
  embedMock: vi.fn()
}));

vi.mock('../../src/server/workflow-instances.js', () => ({
  listRunningInstances: mocks.listRunningInstancesMock,
  updateInstance: mocks.updateInstanceMock
}));
vi.mock('../../src/server/bullmq.js', () => ({
  QUEUES: { agents: 'agents' },
  getQueue: () => ({ getJob: mocks.getJobMock })
}));
vi.mock('../../src/server/pg.js', () => ({ memoryInsert: mocks.memoryInsertMock }));
vi.mock('../../src/server/voyage.js', () => ({ embed: mocks.embedMock }));

import { ttlForStep, isStale, reapTick } from '../../src/worker/reaper.js';

const NOW = 1_750_000_000_000;
const HOUR = 60 * 60 * 1000;

function inst(over = {}) {
  return {
    id: 1, work_item_id: 'wi-1', workflow_name: 'work-item',
    current_step: 'builder', status: 'running',
    last_job_id: '42', last_event_at: NOW - 3 * HOUR,
    metadata: JSON.stringify({ branch: 'feat/x' }),
    ...over
  };
}

describe('reaper', () => {
  beforeEach(() => {
    mocks.listRunningInstancesMock.mockReset();
    mocks.updateInstanceMock.mockReset().mockResolvedValue({});
    mocks.getJobMock.mockReset();
    mocks.memoryInsertMock.mockReset().mockResolvedValue(1);
    mocks.embedMock.mockReset().mockResolvedValue([0.1, 0.2]);
  });

  it('TTL par étape : builder 90 min, merge-coordinator 20 min, défaut 60 min', () => {
    expect(ttlForStep('builder')).toBe(90 * 60 * 1000);
    expect(ttlForStep('merge-coordinator')).toBe(20 * 60 * 1000);
    expect(ttlForStep('unknown-step')).toBe(60 * 60 * 1000);
  });

  it('isStale compare last_event_at au TTL de l’étape', () => {
    expect(isStale(inst({ last_event_at: NOW - 2 * HOUR }), NOW)).toBe(true);
    expect(isStale(inst({ last_event_at: NOW - 10 * 60 * 1000 }), NOW)).toBe(false);
  });

  it('reape une instance stale dont le job BullMQ est mort (failed)', async () => {
    mocks.listRunningInstancesMock.mockResolvedValue([inst()]);
    mocks.getJobMock.mockResolvedValue({ getState: async () => 'failed' });
    const out = await reapTick({ now: NOW });
    expect(out).toEqual({ seen: 1, reaped: 1, skipped: 0 });
    const [keys, patch] = mocks.updateInstanceMock.mock.calls[0];
    expect(keys).toEqual({ work_item_id: 'wi-1', workflow_name: 'work-item' });
    expect(patch.status).toBe('failed');
    const meta = JSON.parse(patch.metadata);
    expect(meta.reaped).toBe(true);
    expect(meta.branch).toBe('feat/x'); // metadata existante préservée (merge)
    expect(mocks.memoryInsertMock).toHaveBeenCalledOnce();
    expect(mocks.memoryInsertMock.mock.calls[0][0].kind).toBe('audit_finding');
  });

  it('ne reape PAS une instance stale dont le job BullMQ est encore actif', async () => {
    mocks.listRunningInstancesMock.mockResolvedValue([inst()]);
    mocks.getJobMock.mockResolvedValue({ getState: async () => 'active' });
    const out = await reapTick({ now: NOW });
    expect(out).toEqual({ seen: 1, reaped: 0, skipped: 1 });
    expect(mocks.updateInstanceMock).not.toHaveBeenCalled();
  });

  it('reape quand le job BullMQ a disparu de la queue', async () => {
    mocks.listRunningInstancesMock.mockResolvedValue([inst()]);
    mocks.getJobMock.mockResolvedValue(null);
    const out = await reapTick({ now: NOW });
    expect(out.reaped).toBe(1);
  });

  it("l'échec du memoryInsert n'empêche pas la réconciliation", async () => {
    mocks.listRunningInstancesMock.mockResolvedValue([inst()]);
    mocks.getJobMock.mockResolvedValue(null);
    mocks.embedMock.mockRejectedValue(new Error('voyage down'));
    const out = await reapTick({ now: NOW });
    expect(out.reaped).toBe(1);
    expect(mocks.updateInstanceMock).toHaveBeenCalledOnce();
  });
});
