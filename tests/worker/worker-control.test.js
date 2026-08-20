// tests/worker/worker-control.test.js
//
// Engine contract §7 — cancel via Redis pub/sub `worker:control`. Uses a
// fake ioredis-like client (EventEmitter) so no real Redis is required.
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  WORKER_CONTROL_CHANNEL,
  publishCancel,
  subscribeWorkerControl,
  createCancelHandler,
} from '../../src/worker/worker-control.js';

function fakeRedisClient() {
  const emitter = new EventEmitter();
  return {
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    on: (event, cb) => emitter.on(event, cb),
    _emitMessage: (channel, raw) => emitter.emit('message', channel, raw),
  };
}

describe('worker-control', () => {
  describe('publishCancel', () => {
    it('publishes a well-formed cancel message on WORKER_CONTROL_CHANNEL', async () => {
      const client = fakeRedisClient();
      await publishCancel(client, 'job-123');
      expect(client.publish).toHaveBeenCalledTimes(1);
      const [channel, raw] = client.publish.mock.calls[0];
      expect(channel).toBe(WORKER_CONTROL_CHANNEL);
      expect(channel).toBe('worker:control');
      const msg = JSON.parse(raw);
      expect(msg.type).toBe('cancel');
      expect(msg.job_id).toBe('job-123');
      expect(typeof msg.requested_at).toBe('number');
    });

    it('stringifies a numeric job id', async () => {
      const client = fakeRedisClient();
      await publishCancel(client, 42);
      const msg = JSON.parse(client.publish.mock.calls[0][1]);
      expect(msg.job_id).toBe('42');
    });

    it('returns the subscriber count Redis reports', async () => {
      const client = fakeRedisClient();
      client.publish.mockResolvedValue(3);
      const n = await publishCancel(client, 'job-1');
      expect(n).toBe(3);
    });
  });

  describe('subscribeWorkerControl', () => {
    it('subscribes to the channel and invokes handler on a matching message', async () => {
      const client = fakeRedisClient();
      const handler = vi.fn();
      await subscribeWorkerControl(client, handler);
      expect(client.subscribe).toHaveBeenCalledWith(WORKER_CONTROL_CHANNEL);

      client._emitMessage(WORKER_CONTROL_CHANNEL, JSON.stringify({ type: 'cancel', job_id: 'j1' }));
      expect(handler).toHaveBeenCalledWith({ type: 'cancel', job_id: 'j1' });
    });

    it('ignores messages on other channels', async () => {
      const client = fakeRedisClient();
      const handler = vi.fn();
      await subscribeWorkerControl(client, handler);
      client._emitMessage('some-other-channel', JSON.stringify({ type: 'cancel', job_id: 'j1' }));
      expect(handler).not.toHaveBeenCalled();
    });

    it('drops malformed JSON without throwing', async () => {
      const client = fakeRedisClient();
      const handler = vi.fn();
      await subscribeWorkerControl(client, handler);
      expect(() => client._emitMessage(WORKER_CONTROL_CHANNEL, 'not json{{{')).not.toThrow();
      expect(handler).not.toHaveBeenCalled();
    });

    it('drops a message with no type field', async () => {
      const client = fakeRedisClient();
      const handler = vi.fn();
      await subscribeWorkerControl(client, handler);
      client._emitMessage(WORKER_CONTROL_CHANNEL, JSON.stringify({ job_id: 'j1' }));
      expect(handler).not.toHaveBeenCalled();
    });

    it('a throwing handler does not crash the subscriber', async () => {
      const client = fakeRedisClient();
      const handler = vi.fn(() => { throw new Error('boom'); });
      await subscribeWorkerControl(client, handler);
      expect(() =>
        client._emitMessage(WORKER_CONTROL_CHANNEL, JSON.stringify({ type: 'cancel', job_id: 'j1' }))
      ).not.toThrow();
    });
  });

  describe('createCancelHandler', () => {
    it('kills the process group for an active job by id', () => {
      const activeProcesses = new Map([
        ['job-1', { process: { pid: 555 }, startedAt: Date.now() }],
      ]);
      const killGroupFn = vi.fn();
      const handle = createCancelHandler(activeProcesses, killGroupFn);
      handle({ type: 'cancel', job_id: 'job-1' });
      expect(killGroupFn).toHaveBeenCalledWith(555, 'SIGTERM');
    });

    it('is a no-op when the job is not active on this worker', () => {
      const activeProcesses = new Map();
      const killGroupFn = vi.fn();
      const handle = createCancelHandler(activeProcesses, killGroupFn);
      expect(() => handle({ type: 'cancel', job_id: 'job-missing' })).not.toThrow();
      expect(killGroupFn).not.toHaveBeenCalled();
    });

    it('ignores non-cancel message types', () => {
      const activeProcesses = new Map([['job-1', { process: { pid: 1 }, startedAt: 0 }]]);
      const killGroupFn = vi.fn();
      const handle = createCancelHandler(activeProcesses, killGroupFn);
      handle({ type: 'set_autonomy', payload: {} });
      expect(killGroupFn).not.toHaveBeenCalled();
    });

    it('coerces numeric job ids the same way jobId keys are stored (string)', () => {
      const activeProcesses = new Map([['42', { process: { pid: 9 }, startedAt: 0 }]]);
      const killGroupFn = vi.fn();
      const handle = createCancelHandler(activeProcesses, killGroupFn);
      handle({ type: 'cancel', job_id: 42 });
      expect(killGroupFn).toHaveBeenCalledWith(9, 'SIGTERM');
    });
  });
});
