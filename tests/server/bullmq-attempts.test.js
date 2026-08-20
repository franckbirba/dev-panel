// tests/server/bullmq-attempts.test.js
//
// Engine contract §4.2 — normative requirement: "BullMQ passe à attempts: 1"
// for the agents queue specifically. Other queues (tickets, github_sync,
// notifications) keep their existing attempts:3 default — only the agents
// queue moves retry decisions into the engine (src/worker/failure-classifier.js).
//
// We can't spin a real Queue without Redis in unit tests, so we assert
// against the BullMQ Queue instance's own defaultJobOptions — which is
// exactly what getQueue(...) configures the Queue with.
import { describe, it, expect, afterAll } from 'vitest';
import { getQueue, QUEUES } from '../../src/server/bullmq.js';

// Requires a reachable Redis (or at least a host BullMQ can lazy-connect
// to without throwing at construction time — Queue() does not connect
// eagerly, so this works even without a live Redis).
describe('bullmq queue-specific attempts (§4.2)', () => {
  afterAll(async () => {
    for (const name of Object.values(QUEUES)) {
      try { await getQueue(name).close(); } catch { /* ignore */ }
    }
  });

  it('agents queue defaults to attempts: 1', () => {
    const queue = getQueue(QUEUES.agents);
    expect(queue.defaultJobOptions.attempts).toBe(1);
  });

  it('tickets queue keeps attempts: 3', () => {
    const queue = getQueue(QUEUES.tickets);
    expect(queue.defaultJobOptions.attempts).toBe(3);
  });

  it('github_sync queue keeps attempts: 3', () => {
    const queue = getQueue(QUEUES.github_sync);
    expect(queue.defaultJobOptions.attempts).toBe(3);
  });

  it('notifications queue keeps attempts: 3', () => {
    const queue = getQueue(QUEUES.notifications);
    expect(queue.defaultJobOptions.attempts).toBe(3);
  });

  it('agents queue keeps exponential backoff + removeOnFail:false (unchanged shape)', () => {
    const queue = getQueue(QUEUES.agents);
    expect(queue.defaultJobOptions.backoff).toEqual({ type: 'exponential', delay: 2000 });
    expect(queue.defaultJobOptions.removeOnFail).toBe(false);
    expect(queue.defaultJobOptions.removeOnComplete).toBe(100);
  });
});
