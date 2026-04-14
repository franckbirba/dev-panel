// src/worker/index.js
import { Worker } from 'bullmq';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildPrompt, parseResult } from './prompt-builder.js';
import { QUEUES, PRIORITY_MAP, getQueue } from '../server/bullmq.js';
import { registerCrons } from './crons.js';
import { runAutomation } from './automation.js';
import { logStep } from '../server/jobs-log.js';
import { notifyJob } from '../server/alerts.js';
import { initMasterDatabase } from '../server/db.js';

const require = createRequire(import.meta.url);
const Redis = require('ioredis');

// Config
const REDIS_HOST = process.env.REDIS_HOST || '77.42.46.87';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '3');
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const MODE_FILE = process.env.MODE_FILE || join(process.env.HOME || '/home/deploy', '.shelly-mode.json');

const connection = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

initMasterDatabase(process.env.DEVPANEL_STORAGE || './storage');

// Active processes map: jobId -> { process, startedAt }
const activeProcesses = new Map();

/**
 * Read current Shelly mode
 */
function getMode() {
  try {
    if (existsSync(MODE_FILE)) {
      return JSON.parse(readFileSync(MODE_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return { mode: 'collaborative', since: new Date().toISOString(), morning_review: [] };
}

/**
 * Append to morning review log
 */
function logMorningReview(entry) {
  const state = getMode();
  state.morning_review.push({
    ...entry,
    timestamp: new Date().toISOString()
  });
  writeFileSync(MODE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Spawn claude -p and return the output
 */
function spawnAgent(jobId, prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', prompt, '--print', '--dangerously-skip-permissions'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: [
          join(process.env.HOME || '/home/deploy', '.bun/bin'),
          join(process.env.HOME || '/home/deploy', '.local/bin'),
          join(process.env.HOME || '/home/deploy', '.npm-global/bin'),
          '/usr/local/bin',
          '/usr/bin',
          '/bin'
        ].join(':')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    activeProcesses.set(jobId, { process: proc, startedAt: Date.now() });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      activeProcesses.delete(jobId);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`claude -p exited with code ${code}\nstderr: ${stderr.slice(-1000)}`));
      }
    });

    proc.on('error', (err) => {
      activeProcesses.delete(jobId);
      reject(err);
    });
  });
}

// ============================================================================
// WORKER
// ============================================================================

const worker = new Worker(QUEUES.agents, async (job) => {
  // Normalize jobData: guarantee job_id is set (legacy crons don't carry it),
  // and preserve the legacy task.{id,title} shape as a fallback for buildPrompt
  // / logs until all producers move to the new work_item shape.
  const jobData = { job_id: job.id, ...job.data };
  const { agent, task } = jobData;
  const taskLabel = task?.id || jobData.plane?.work_item_id || job.id;
  console.log(`[Worker] Starting job ${job.id} — ${agent}:${taskLabel} (priority: ${job.opts.priority})`);

    if (jobData.agent === 'deploy') {
      const { handleDeploy } = await import('./handlers/deploy.js');
      const startedAt = Date.now();
      const result = await handleDeploy(jobData);
      await runAutomation({ jobData, result, startedAt });
      return result;
    }

  // Build prompt
  const prompt = buildPrompt(jobData);

  const startedAt = Date.now();

  // Emit job.started to admin SSE (non-blocking)
  if (process.env.ADMIN_API_KEY) {
    fetch(process.env.WORKER_EVENTS_URL || 'http://localhost:3030/api/admin/events/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': process.env.ADMIN_API_KEY },
      body: JSON.stringify({ event: 'job.started', data: { job_id: jobData.job_id, agent: jobData.agent, work_item_id: jobData.plane?.work_item_id } })
    }).catch(() => {});
  }

  // Spawn agent
  const output = await spawnAgent(job.id, prompt);

  // Parse result (strict: returns { ok, data } | { ok: false, error })
  const parsed = parseResult(output);
  if (!parsed.ok) {
    logStep({ job_id: jobData.job_id, agent: jobData.agent, step: 'parseResult',
              status: 'error', error: parsed.error });
    await notifyJob({
      job_id: jobData.job_id, agent: jobData.agent,
      work_item_id: jobData.plane?.work_item_id || jobData.task?.id,
      title: jobData.work_item?.title || jobData.task?.title,
      status: 'failed',
      extra: `parseResult: ${parsed.error}`
    });
    throw new Error(`parseResult failed: ${parsed.error}`);
  }
  logStep({ job_id: jobData.job_id, agent: jobData.agent, step: 'parseResult', status: 'ok' });

  await runAutomation({ jobData, result: parsed.data, startedAt });

  const result = {
    ...parsed.data,
    agent,
    task_id: task?.id || null,
    raw_length: output.length
  };

  console.log(`[Worker] Job ${job.id} completed — ${result.summary?.slice(0, 100)}`);

  return result;

}, {
  connection,
  concurrency: CONCURRENCY,
  stalledInterval: 120000,
  lockDuration: 1800000
});

// ============================================================================
// PIPELINE: builder -> reviewer -> merge
// ============================================================================

worker.on('completed', async (job, result) => {
  const { agent, task, source } = job.data;
  const mode = getMode();

  console.log(`[Pipeline] ${agent}:${task.id} completed (mode: ${mode.mode})`);

  // Log for morning review if autonomous
  if (mode.mode === 'autonomous') {
    logMorningReview({
      type: 'completed',
      job_id: job.id,
      agent,
      task_id: task.id,
      task_title: task.title,
      summary: result?.summary || 'No summary'
    });
  }

  // Chain: builder (tests passed) -> reviewer
  if (agent === 'builder' && result?.tests_passed && source !== 'pipeline') {
    const agentsQueue = getQueue(QUEUES.agents);
    await agentsQueue.add(`review:${task.id}`, {
      agent: 'reviewer',
      task: {
        ...task,
        builder_output: result
      },
      skills: ['agent-reviewer'],
      source: 'pipeline',
      requested_by: 'worker'
    }, {
      priority: PRIORITY_MAP.p1
    });
    console.log(`[Pipeline] Enqueued reviewer for ${task.id}`);
  }

  // Chain: reviewer approved (autonomous mode) -> log merge-ready
  if (agent === 'reviewer' && source === 'pipeline') {
    if (mode.mode === 'autonomous') {
      logMorningReview({
        type: 'merge_ready',
        task_id: task.id,
        task_title: task.title,
        branch: task.branch,
        review_result: result?.summary || 'Approved'
      });
      console.log(`[Pipeline] ${task.id} merge-ready (autonomous — logged for morning review)`);
    } else {
      console.log(`[Pipeline] ${task.id} review done — awaiting Franck validation (collaborative mode)`);
    }
  }
});

worker.on('failed', (job, err) => {
  const { agent, task } = job.data;
  const mode = getMode();

  console.error(`[Worker] Job ${job.id} failed — ${agent}:${task.id}: ${err.message}`);

  // If max attempts reached, log for morning review
  if (job.attemptsMade >= (job.opts.attempts || 3)) {
    if (mode.mode === 'autonomous') {
      logMorningReview({
        type: 'failed',
        job_id: job.id,
        agent,
        task_id: task.id,
        task_title: task.title,
        error: err.message
      });
    }
  }
});

worker.on('error', (err) => {
  console.error('[Worker] Error:', err);
});

// ============================================================================
// STARTUP
// ============================================================================

console.log(`[Worker] Starting on ${REDIS_HOST}:${REDIS_PORT} with concurrency ${CONCURRENCY}`);
console.log(`[Worker] Project root: ${PROJECT_ROOT}`);
console.log(`[Worker] Mode file: ${MODE_FILE}`);

// Register crons
registerCrons().catch(err => console.error('[Crons] Registration failed:', err));

// Export for api.js
export { activeProcesses, worker, getMode };

// Start worker API server
import('./api.js').catch(err => console.error('[Worker API] Failed to start:', err));
