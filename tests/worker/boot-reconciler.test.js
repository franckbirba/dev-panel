// tests/worker/boot-reconciler.test.js
//
// Engine contract §8 — boot-time reconciliation. Pure decision functions
// tested directly; the orchestrator tested with fake queue/db collaborators
// (no real Postgres/Redis required).
import { describe, it, expect, vi } from 'vitest';
import {
  decideInstanceReconciliation,
  decideOrphanedActiveJobs,
  reconcileOnBoot,
  killOrphanedSpawnProcesses,
  DEFAULT_STALE_INSTANCE_TTL_MS,
} from '../../src/worker/boot-reconciler.js';

const NOW = 1_000_000_000_000; // fixed reference instant for deterministic TTL math

function queueStub({ active = [], waiting = [], delayed = [] } = {}) {
  return {
    getActive: vi.fn().mockResolvedValue(active),
    getWaiting: vi.fn().mockResolvedValue(waiting),
    getDelayed: vi.fn().mockResolvedValue(delayed),
  };
}

describe('boot-reconciler', () => {
  describe('decideInstanceReconciliation', () => {
    it('reconciles a live instance whose last_job_id is not in the live set AND is past the TTL', () => {
      const instances = [
        {
          id: 1, work_item_id: 'wi-1', workflow_name: 'work-item',
          last_job_id: 'job-dead', status: 'running',
          last_event_at: NOW - DEFAULT_STALE_INSTANCE_TTL_MS - 1000,
        },
      ];
      const out = decideInstanceReconciliation(instances, new Set(), { now: NOW });
      expect(out).toEqual([
        { instance: instances[0], action: 'reconcile', reason: 'stale_reconciled' },
      ]);
    });

    it('keeps a not-backed instance that is still within the TTL (e.g. fresh awaiting_input)', () => {
      const instances = [
        {
          id: 2, work_item_id: 'wi-2', workflow_name: 'work-item',
          last_job_id: null, status: 'awaiting_input',
          last_event_at: NOW - 5 * 60 * 1000, // 5 min ago — well within 24h TTL
        },
      ];
      const out = decideInstanceReconciliation(instances, new Set(), { now: NOW });
      expect(out).toEqual([{ instance: instances[0], action: 'keep', reason: 'within_ttl' }]);
    });

    it('keeps an instance whose last_job_id IS in the live set, regardless of age', () => {
      const instances = [
        {
          id: 3, work_item_id: 'wi-3', workflow_name: 'work-item',
          last_job_id: 'job-alive', status: 'running',
          last_event_at: NOW - DEFAULT_STALE_INSTANCE_TTL_MS - 1000, // would be stale if not backed
        },
      ];
      const out = decideInstanceReconciliation(instances, new Set(['job-alive']), { now: NOW });
      expect(out).toEqual([{ instance: instances[0], action: 'keep' }]);
    });

    it('reconciles an instance with no last_job_id at all once past the TTL', () => {
      const instances = [
        {
          id: 4, work_item_id: 'wi-4', workflow_name: 'work-item',
          last_job_id: null, status: 'awaiting_input',
          last_event_at: NOW - DEFAULT_STALE_INSTANCE_TTL_MS - 1,
        },
      ];
      const out = decideInstanceReconciliation(instances, new Set(['anything']), { now: NOW });
      expect(out[0].action).toBe('reconcile');
    });

    it('treats a missing/garbage last_event_at as epoch 0 — always past the TTL', () => {
      const instances = [
        { id: 5, work_item_id: 'wi-5', workflow_name: 'work-item', last_job_id: null, status: 'running' },
      ];
      const out = decideInstanceReconciliation(instances, new Set(), { now: NOW });
      expect(out[0].action).toBe('reconcile');
    });

    it('handles a mixed batch independently', () => {
      const instances = [
        { id: 1, last_job_id: 'a', work_item_id: 'wi-a', workflow_name: 'work-item', last_event_at: NOW },
        {
          id: 2, last_job_id: 'b', work_item_id: 'wi-b', workflow_name: 'work-item',
          last_event_at: NOW - DEFAULT_STALE_INSTANCE_TTL_MS - 1,
        },
      ];
      const out = decideInstanceReconciliation(instances, new Set(['a']), { now: NOW });
      expect(out[0].action).toBe('keep');
      expect(out[1].action).toBe('reconcile');
    });

    it('coerces a numeric last_job_id to string for the Set lookup', () => {
      const instances = [{ id: 1, last_job_id: 42, work_item_id: 'wi-1', workflow_name: 'work-item', last_event_at: NOW }];
      const out = decideInstanceReconciliation(instances, new Set(['42']), { now: NOW });
      expect(out[0].action).toBe('keep');
    });

    it('respects a custom staleTtlMs override', () => {
      const instances = [
        { id: 6, work_item_id: 'wi-6', workflow_name: 'work-item', last_job_id: null, last_event_at: NOW - 10_000 },
      ];
      // With a 5s TTL, 10s of silence is already stale.
      const out = decideInstanceReconciliation(instances, new Set(), { now: NOW, staleTtlMs: 5000 });
      expect(out[0].action).toBe('reconcile');
    });
  });

  describe('decideOrphanedActiveJobs', () => {
    it('every active job is orphaned when livePids is empty (boot-time premise)', () => {
      const jobs = [{ id: 'j1' }, { id: 'j2' }];
      const out = decideOrphanedActiveJobs(jobs, new Set());
      expect(out).toEqual([
        { job_id: 'j1', action: 'fail_no_rerun' },
        { job_id: 'j2', action: 'fail_no_rerun' },
      ]);
    });

    it('a job present in livePids is not orphaned', () => {
      const jobs = [{ id: 'j1' }, { id: 'j2' }];
      const out = decideOrphanedActiveJobs(jobs, new Set(['j1']));
      expect(out).toEqual([{ job_id: 'j2', action: 'fail_no_rerun' }]);
    });

    it('empty input yields empty output', () => {
      expect(decideOrphanedActiveJobs([], new Set())).toEqual([]);
    });
  });

  describe('reconcileOnBoot (orchestration, fake collaborators)', () => {
    it('clears orphaned active jobs and reconciles a stale live instance, idempotently', async () => {
      const job1 = { id: 'j1', discard: vi.fn().mockResolvedValue(), remove: vi.fn().mockResolvedValue() };
      const queue = queueStub({ active: [job1] });
      const liveInstances = [
        {
          id: 10, work_item_id: 'wi-10', workflow_name: 'work-item', last_job_id: 'j1',
          status: 'running', metadata: null, last_event_at: NOW - DEFAULT_STALE_INSTANCE_TTL_MS - 1,
        },
      ];
      const updateInstance = vi.fn().mockResolvedValue({});
      const listLiveInstances = vi.fn().mockResolvedValue(liveInstances);
      const notify = vi.fn();

      const summary = await reconcileOnBoot({ queue, listLiveInstances, updateInstance, notify, now: NOW });

      expect(summary.failed_active_jobs).toBe(1);
      expect(summary.reconciled_instances).toBe(1);
      expect(job1.discard).toHaveBeenCalled();
      expect(job1.remove).toHaveBeenCalled();
      expect(updateInstance).toHaveBeenCalledWith(
        { work_item_id: 'wi-10', workflow_name: 'work-item' },
        expect.objectContaining({ status: 'failed' })
      );
      const patchArg = updateInstance.mock.calls[0][1];
      const meta = JSON.parse(patchArg.metadata);
      expect(meta.reconcile_reason).toBe('stale_reconciled');
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('does NOT reconcile a live instance backed by a still-waiting job (sibling worker will pick it up)', async () => {
      const queue = queueStub({ waiting: [{ id: 'w1' }] });
      const liveInstances = [
        {
          id: 11, work_item_id: 'wi-11', workflow_name: 'work-item', last_job_id: 'w1',
          status: 'running', last_event_at: NOW - DEFAULT_STALE_INSTANCE_TTL_MS - 1,
        },
      ];
      const updateInstance = vi.fn();
      const summary = await reconcileOnBoot({
        queue, listLiveInstances: vi.fn().mockResolvedValue(liveInstances),
        updateInstance, notify: vi.fn(), now: NOW,
      });
      expect(summary.reconciled_instances).toBe(0);
      expect(updateInstance).not.toHaveBeenCalled();
    });

    it('does NOT reconcile a fresh awaiting_input instance with no backing job (waiting on a human)', async () => {
      const queue = queueStub();
      const liveInstances = [
        {
          id: 12, work_item_id: 'wi-12', workflow_name: 'work-item', last_job_id: null,
          status: 'awaiting_input', last_event_at: NOW - 60_000, // 1 min ago
        },
      ];
      const updateInstance = vi.fn();
      const summary = await reconcileOnBoot({
        queue, listLiveInstances: vi.fn().mockResolvedValue(liveInstances),
        updateInstance, notify: vi.fn(), now: NOW,
      });
      expect(summary.reconciled_instances).toBe(0);
      expect(updateInstance).not.toHaveBeenCalled();
    });

    it('is a no-op (no notify) when nothing needs reconciling', async () => {
      const queue = queueStub();
      const listLiveInstances = vi.fn().mockResolvedValue([]);
      const updateInstance = vi.fn();
      const notify = vi.fn();

      const summary = await reconcileOnBoot({ queue, listLiveInstances, updateInstance, notify, now: NOW });

      expect(summary.reconciled_instances).toBe(0);
      expect(summary.failed_active_jobs).toBe(0);
      expect(updateInstance).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('does not throw when queue.getActive() rejects — degrades to instance-only reconciliation', async () => {
      const queue = queueStub();
      queue.getActive = vi.fn().mockRejectedValue(new Error('redis down'));
      const listLiveInstances = vi.fn().mockResolvedValue([]);
      const updateInstance = vi.fn();
      await expect(reconcileOnBoot({ queue, listLiveInstances, updateInstance, notify: vi.fn(), now: NOW }))
        .resolves.toEqual(expect.objectContaining({ failed_active_jobs: 0 }));
    });

    it('does not throw when listLiveInstances() rejects — degrades to job-only reconciliation', async () => {
      const queue = queueStub();
      const listLiveInstances = vi.fn().mockRejectedValue(new Error('pg down'));
      const updateInstance = vi.fn();
      await expect(reconcileOnBoot({ queue, listLiveInstances, updateInstance, notify: vi.fn(), now: NOW }))
        .resolves.toEqual(expect.objectContaining({ reconciled_instances: 0 }));
    });

    it('a second run finds nothing left to reconcile (idempotent)', async () => {
      const queue = queueStub(); // already cleared
      const listLiveInstances = vi.fn().mockResolvedValue([]); // already reconciled to failed, no longer "live"
      const updateInstance = vi.fn();
      const summary = await reconcileOnBoot({ queue, listLiveInstances, updateInstance, notify: vi.fn(), now: NOW });
      expect(summary.reconciled_instances).toBe(0);
      expect(summary.failed_active_jobs).toBe(0);
    });

    it('one failing job.remove() does not stop the rest of the batch', async () => {
      const job1 = { id: 'j1', discard: vi.fn().mockRejectedValue(new Error('nope')), remove: vi.fn() };
      const job2 = { id: 'j2', discard: vi.fn().mockResolvedValue(), remove: vi.fn().mockResolvedValue() };
      const queue = queueStub({ active: [job1, job2] });
      const summary = await reconcileOnBoot({
        queue,
        listLiveInstances: vi.fn().mockResolvedValue([]),
        updateInstance: vi.fn(),
        notify: vi.fn(),
        now: NOW,
      });
      // Both counted (the counting happens before the discard/remove call in
      // the loop body is awaited per-job; a per-job try/catch means job2
      // still gets cleared even though job1's discard rejected).
      expect(summary.failed_active_jobs).toBe(2);
      expect(job2.remove).toHaveBeenCalled();
    });
  });

  describe('killOrphanedSpawnProcesses', () => {
    it('kills every pid returned by listSpawnSignaturePids', () => {
      const killPid = vi.fn();
      const out = killOrphanedSpawnProcesses({
        listSpawnSignaturePids: () => ['111', '222'],
        killPid,
      });
      expect(out.killed).toEqual(['111', '222']);
      expect(killPid).toHaveBeenCalledWith('111');
      expect(killPid).toHaveBeenCalledWith('222');
    });

    it('returns empty and does not throw when listing fails', () => {
      const out = killOrphanedSpawnProcesses({
        listSpawnSignaturePids: () => { throw new Error('pgrep not found'); },
        killPid: vi.fn(),
      });
      expect(out.killed).toEqual([]);
    });

    it('a single failing kill does not stop the rest', () => {
      const killPid = vi.fn()
        .mockImplementationOnce(() => { throw new Error('ESRCH'); })
        .mockImplementationOnce(() => {});
      const out = killOrphanedSpawnProcesses({
        listSpawnSignaturePids: () => ['1', '2'],
        killPid,
      });
      expect(out.killed).toEqual(['2']);
    });

    it('empty pid list is a clean no-op', () => {
      const out = killOrphanedSpawnProcesses({ listSpawnSignaturePids: () => [], killPid: vi.fn() });
      expect(out.killed).toEqual([]);
    });
  });
});
