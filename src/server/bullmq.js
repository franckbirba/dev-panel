// ============================================================================
// BULLMQ QUEUE MANAGEMENT WITH DEAD LETTER QUEUE
// ============================================================================

import { Queue, Worker, QueueEvents } from 'bullmq';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Redis = require('ioredis');

// Redis connection config
const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null,
  enableReadyCheck: false
};

// Queue configurations
const QUEUES = {
  tickets: 'devpanel-tickets',
  github_sync: 'devpanel-github-sync',
  notifications: 'devpanel-notifications',
  agents: 'devpanel-agents',
  dlq: 'devpanel-dead-letter'
};

const PRIORITY_MAP = {
  p0: 1,   // urgent
  p1: 5,   // high
  p2: 10,  // normal
  p3: 20   // low
};

// Queues must be memoized: `new Queue()` opens a Redis connection and
// callers like getAllQueuesHealth() hit this on a 5s SSE loop. Without
// caching, the server bled ~951 zombie clients in 12min and OOM'd at 50.
const queueCache = new Map();
let sharedConnection = null;

function getSharedConnection() {
  if (!sharedConnection) sharedConnection = new Redis(REDIS_CONFIG);
  return sharedConnection;
}

/**
 * Create or get a BullMQ queue (cached per queueName)
 * @param {string} queueName - Queue name from QUEUES
 * @returns {Queue} BullMQ queue instance
 */
export function getQueue(queueName) {
  const cached = queueCache.get(queueName);
  if (cached) return cached;

  const queue = new Queue(queueName, {
    connection: getSharedConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      },
      removeOnComplete: 100, // Keep last 100 completed jobs
      removeOnFail: false // Keep failed jobs for DLQ
    }
  });
  queueCache.set(queueName, queue);
  return queue;
}

/**
 * Create a worker for processing jobs
 * @param {string} queueName - Queue name
 * @param {Function} processor - Job processor function
 * @returns {Worker} BullMQ worker instance
 */
export function createWorker(queueName, processor) {
  const connection = new Redis(REDIS_CONFIG);

  const worker = new Worker(queueName, async (job) => {
    console.log(`[Worker] Processing job ${job.id} from ${queueName}`);

    try {
      await processor(job);
      console.log(`[Worker] Job ${job.id} completed successfully`);
    } catch (error) {
      console.error(`[Worker] Job ${job.id} failed:`, error);

      // Move to DLQ after max attempts
      if (job.attemptsMade >= job.opts.attempts) {
        await moveToDLQ(job, error);
      }

      throw error; // Re-throw to trigger BullMQ retry logic
    }
  }, {
    connection,
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5'),
    limiter: {
      max: 10,
      duration: 1000 // 10 jobs per second max
    }
  });

  // Worker event handlers
  worker.on('completed', (job) => {
    console.log(`✓ Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`✗ Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error('[Worker] Error:', err);
  });

  return worker;
}

/**
 * Move failed job to Dead Letter Queue
 * @param {Object} job - Failed job
 * @param {Error} error - Error that caused failure
 */
async function moveToDLQ(job, error) {
  const dlq = getQueue(QUEUES.dlq);

  await dlq.add('failed_job', {
    original_queue: job.queueName,
    original_job_id: job.id,
    original_data: job.data,
    error_message: error.message,
    error_stack: error.stack,
    failed_at: new Date().toISOString(),
    attempts: job.attemptsMade
  }, {
    removeOnComplete: false, // Never remove DLQ jobs
    removeOnFail: false
  });

  console.log(`[DLQ] Moved job ${job.id} from ${job.queueName} to dead letter queue`);
}

/**
 * Get Dead Letter Queue jobs
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Failed jobs
 */
export async function getDLQJobs(options = {}) {
  const dlq = getQueue(QUEUES.dlq);
  const { start = 0, end = -1 } = options;

  const jobs = await dlq.getJobs(['completed', 'failed', 'delayed'], start, end);

  return jobs.map(job => ({
    id: job.id,
    original_queue: job.data.original_queue,
    original_job_id: job.data.original_job_id,
    error: job.data.error_message,
    failed_at: job.data.failed_at,
    attempts: job.data.attempts,
    data: job.data.original_data
  }));
}

/**
 * Retry a job from DLQ
 * @param {string} dlqJobId - DLQ job ID
 */
export async function retryFromDLQ(dlqJobId) {
  const dlq = getQueue(QUEUES.dlq);
  const job = await dlq.getJob(dlqJobId);

  if (!job) {
    throw new Error(`DLQ job ${dlqJobId} not found`);
  }

  const originalQueue = getQueue(job.data.original_queue);
  const newJob = await originalQueue.add(job.data.original_data.name || 'retry', job.data.original_data);

  await job.remove();

  console.log(`[DLQ] Retried job ${dlqJobId} as ${newJob.id} in ${job.data.original_queue}`);

  return newJob;
}

/**
 * Clear DLQ (use with caution)
 */
export async function clearDLQ() {
  const dlq = getQueue(QUEUES.dlq);
  await dlq.obliterate({ force: true });
  console.log('[DLQ] Cleared all dead letter queue jobs');
}

/**
 * Get queue health status
 * @param {string} queueName - Queue name
 * @returns {Promise<Object>} Queue health metrics
 */
export async function getQueueHealth(queueName) {
  const queue = getQueue(queueName);

  const [waiting, active, delayed, failed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getDelayedCount(),
    queue.getFailedCount()
  ]);

  const isPaused = await queue.isPaused();

  const health = {
    queue: queueName,
    status: failed > 100 ? 'critical' : active > 50 ? 'warning' : 'healthy',
    counts: {
      waiting,
      active,
      delayed,
      failed
    },
    paused: isPaused,
    timestamp: new Date().toISOString()
  };

  return health;
}

/**
 * Get all queues health
 * @returns {Promise<Object>} All queues health status
 */
export async function getAllQueuesHealth() {
  const queues = Object.values(QUEUES);

  const healthChecks = await Promise.all(
    queues.map(q => getQueueHealth(q))
  );

  const overall = healthChecks.every(h => h.status === 'healthy')
    ? 'healthy'
    : healthChecks.some(h => h.status === 'critical')
    ? 'critical'
    : 'warning';

  return {
    status: overall,
    queues: healthChecks,
    timestamp: new Date().toISOString()
  };
}

/**
 * Monitor queue and emit alerts
 * @param {string} queueName - Queue name
 * @param {Function} alertCallback - Alert callback function
 */
export function monitorQueue(queueName, alertCallback) {
  const queueEvents = new QueueEvents(queueName, {
    connection: new Redis(REDIS_CONFIG)
  });

  queueEvents.on('failed', async ({ jobId, failedReason }) => {
    const queue = getQueue(queueName);
    const job = await queue.getJob(jobId);

    if (job && job.attemptsMade >= job.opts.attempts) {
      alertCallback({
        severity: 'critical',
        message: `Job ${jobId} exhausted all retries`,
        queue: queueName,
        error: failedReason,
        timestamp: new Date().toISOString()
      });
    }
  });

  queueEvents.on('stalled', ({ jobId }) => {
    alertCallback({
      severity: 'warning',
      message: `Job ${jobId} stalled`,
      queue: queueName,
      timestamp: new Date().toISOString()
    });
  });

  return queueEvents;
}

/**
 * Get jobs from a queue filtered by state
 */
export async function getQueueJobs(queueName, status = 'waiting', start = 0, limit = 50) {
  const queue = getQueue(queueName);
  const jobs = await queue.getJobs([status], start, start + limit - 1);

  return jobs.map(job => ({
    id: job.id,
    name: job.name,
    status,
    data: JSON.stringify(job.data).length > 1024
      ? JSON.parse(JSON.stringify(job.data).slice(0, 1024) + '..."}}')
      : job.data,
    attempts: job.attemptsMade,
    max_attempts: job.opts?.attempts,
    timestamp: job.timestamp,
    processed_on: job.processedOn,
    finished_on: job.finishedOn,
    progress: job.progress,
    failed_reason: job.failedReason,
  }));
}

/**
 * Get full job detail
 */
export async function getJobDetail(queueName, jobId) {
  const queue = getQueue(queueName);
  const job = await queue.getJob(jobId);

  if (!job) return null;

  const state = await job.getState();

  return {
    id: job.id,
    name: job.name,
    status: state,
    data: job.data,
    opts: job.opts,
    attempts: job.attemptsMade,
    max_attempts: job.opts?.attempts,
    timestamp: job.timestamp,
    processed_on: job.processedOn,
    finished_on: job.finishedOn,
    progress: job.progress,
    failed_reason: job.failedReason,
    stacktrace: job.stacktrace,
    return_value: job.returnvalue,
  };
}

/**
 * Validate queue name against known queues
 */
export function resolveQueueName(name) {
  const match = Object.entries(QUEUES).find(
    ([key, fullName]) => key === name || fullName === name
  );
  return match ? match[1] : null;
}

export { QUEUES, PRIORITY_MAP };
