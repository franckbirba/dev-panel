// src/worker/index.js
import { Worker } from 'bullmq';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildPrompt, parseResult } from './prompt-builder.js';
import { QUEUES } from '../server/bullmq.js';
import { registerCrons } from './crons.js';
import { startBacklogPuller } from './backlog-puller.js';

// Resolve per-project Plane settings, preferring the project's own
// .devpanlrc.json over the worker's PLANE_* env vars. This is what lets
// the same agent worker serve N projects (zeno, edms, dev-panel, ...)
// without env collisions — each project owns its own plane.project_id.
function resolveProjectPlane(projectRoot) {
  try {
    const rcPath = join(projectRoot, '.devpanlrc.json');
    if (existsSync(rcPath)) {
      const rc = JSON.parse(readFileSync(rcPath, 'utf8'));
      if (rc?.plane?.project_id && rc.plane.project_id !== '__SET_ME__') {
        return {
          base: (process.env.PLANE_BASE_URL || '').replace(/\/$/, ''),
          slug: rc.plane.workspace_slug || process.env.PLANE_WORKSPACE_SLUG,
          key:  process.env.PLANE_API_KEY,
          pid:  rc.plane.project_id
        };
      }
    }
  } catch { /* fall through to env */ }
  return {
    base: (process.env.PLANE_BASE_URL || '').replace(/\/$/, ''),
    slug: process.env.PLANE_WORKSPACE_SLUG,
    key:  process.env.PLANE_API_KEY,
    pid:  process.env.PLANE_PROJECT_ID
  };
}

// Enrich jobData.work_item from Plane REST if the payload only has the ID.
// This runs unconditionally before prompt build so every code path — CLI
// dispatch, backlog puller, engine replan resume — gets the same context.
async function enrichWorkItemFromPlane(jobData) {
  const wi = jobData.work_item || {};
  const id = jobData.plane?.work_item_id;
  if (!id) return;
  if (wi.title && wi.description) return; // already populated
  const projectRoot = jobData.context?.project_root || PROJECT_ROOT;
  const { base, slug, key, pid } = resolveProjectPlane(projectRoot);
  if (!base || !slug || !key || !pid) return;
  try {
    const res = await fetch(
      `${base}/api/v1/workspaces/${slug}/projects/${pid}/issues/${id}/`,
      { headers: { 'X-API-Key': key } }
    );
    if (!res.ok) { console.warn(`[enrich] plane ${res.status} for ${id}`); return; }
    const i = await res.json();
    const desc = (i.description_html || '')
      .replace(/<\/?(p|div|h[1-6]|li|br)[^>]*>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n').trim();
    jobData.work_item = {
      sequence_id: i.sequence_id,
      title: i.name,
      name: i.name,
      description: desc,
      priority: i.priority,
      ...wi
    };
  } catch (err) {
    console.warn(`[enrich] plane lookup failed for ${id}: ${err.message}`);
  }
}
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
function spawnAgent(jobId, prompt, agentRole = 'unknown') {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', prompt, '--print', '--dangerously-skip-permissions'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        // Propagate identity into the MCP subprocess so memory_write can
        // record writes against this job and tag them with the agent role.
        JOB_ID: jobId,
        AGENT_ROLE: agentRole,
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

    if (jobData.agent === 'shelly_digest') {
      const { handleShellyDigest } = await import('./handlers/shelly-digest.js');
      const startedAt = Date.now();
      const result = await handleShellyDigest(jobData);
      // No runAutomation here — the digest handler already notified;
      // running the workflow engine on a non-workflow job would just no-op.
      return result;
    }

  // Enrich work_item from Plane REST when the payload only carries the ID.
  // Engine-resumed jobs (replan → re-enqueue) and cron dispatches only know
  // plane.work_item_id; agents therefore lose all task context. Bypasses
  // plane-mcp's pydantic deserialisation bug entirely.
  await enrichWorkItemFromPlane(jobData);

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

  // Spawn agent (propagate job_id + agent role to MCP subprocess)
  const output = await spawnAgent(jobData.job_id, prompt, jobData.agent);

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
  const taskId = task?.id || job.data.plane?.work_item_id || job.id;
  const taskTitle = task?.title || job.data.work_item?.title;

  console.log(`[Pipeline] ${agent}:${taskId} completed (mode: ${mode.mode})`);

  // Log for morning review if autonomous
  if (mode.mode === 'autonomous') {
    logMorningReview({
      type: 'completed',
      job_id: job.id,
      agent,
      task_id: taskId,
      task_title: taskTitle,
      summary: result?.summary || 'No summary'
    });
  }

  // Chaining is owned by workflow.trigger_next (see src/worker/engine.js).
});

worker.on('failed', (job, err) => {
  const { agent, task } = job.data;
  const mode = getMode();
  const taskId = task?.id || job.data.plane?.work_item_id || job.id;
  const taskTitle = task?.title || job.data.work_item?.title;

  console.error(`[Worker] Job ${job.id} failed — ${agent}:${taskId}: ${err.message}`);

  // If max attempts reached, log for morning review
  if (job.attemptsMade >= (job.opts.attempts || 3)) {
    if (mode.mode === 'autonomous') {
      logMorningReview({
        type: 'failed',
        job_id: job.id,
        agent,
        task_id: taskId,
        task_title: taskTitle,
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

// Start the continuous Plane backlog → workflow dispatcher.
// This is what keeps the team busy 24/7: every N minutes it pulls Todos
// and enqueues work-item workflows for each (dedup via workflow_instances
// unique index). Disabled cleanly if Plane env vars are missing.
startBacklogPuller();

// Export for api.js
export { activeProcesses, worker, getMode };

// Start worker API server
import('./api.js').catch(err => console.error('[Worker API] Failed to start:', err));
