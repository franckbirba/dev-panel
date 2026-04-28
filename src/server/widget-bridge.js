// src/server/widget-bridge.js
//
// BullMQ enqueue helper for the widget → Shelly publique queue. Writes to a
// dedicated queue `shelly-public-inbound`, NOT muxed onto the agents queue —
// chat traffic must never queue behind a 10-min build job, and a stuck widget
// message must not block agent dispatches.
//
// Same Redis instance as the rest of the stack. The actual queue creation
// is shared with src/server/bullmq.js (via getSharedConnection memoisation),
// but the queue name is owned by this module.

import { Queue } from 'bullmq';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Redis = require('ioredis');

export const SHELLY_PUBLIC_INBOUND_QUEUE = 'shelly-public-inbound';

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null,
  enableReadyCheck: false
};

let cachedQueue = null;
let cachedConnection = null;
let injectedQueue = null;

function getQueue() {
  if (injectedQueue) return injectedQueue;
  if (cachedQueue) return cachedQueue;
  if (!cachedConnection) cachedConnection = new Redis(REDIS_CONFIG);
  cachedQueue = new Queue(SHELLY_PUBLIC_INBOUND_QUEUE, {
    connection: cachedConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 100
    }
  });
  return cachedQueue;
}

// Test injection point. Pass a fake queue with `.add(name, data)` to bypass
// Redis. Pass null to restore the real queue.
export function _setInboundQueueForTests(fake) {
  injectedQueue = fake;
}

// Push a widget message onto the public-Shelly inbound queue. Returns the
// BullMQ job_id (or whatever the injected fake returns).
export async function enqueueWidgetMessage({ session_id, project_id, message_id, content }) {
  if (!session_id || !project_id || !content) {
    throw new Error('enqueueWidgetMessage: session_id, project_id, content required');
  }
  const queue = getQueue();
  const job = await queue.add('widget-inbound', {
    session_id,
    project_id,
    message_id: message_id ?? null,
    content,
    enqueued_at: new Date().toISOString()
  });
  return job?.id ?? null;
}
