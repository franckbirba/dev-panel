// src/worker/index.js
import { Worker } from 'bullmq';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from 'fs';
import { join } from 'path';
import { buildPrompt, parseResult } from './prompt-builder.js';
import { createStreamParser, getFinalResultText, classifyEvent } from './stream-parser.js';
import { appendEvent, broadcastDone } from '../server/jobs-events.js';
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
import { prepareWorktree, shouldUseWorktree } from './worktree.js';
import { updateInstance } from '../server/workflow-instances.js';
import { spawnGoose, shouldUseGoose } from './goose-driver.js';
import { spawnMiniSwe, shouldUseMiniSwe } from './mini-swe-driver.js';
import { selectClaudeModel } from './select-claude-model.js';

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

const AGENT_LOG_DIR = join(process.env.DEVPANEL_STORAGE || './storage', 'agent-logs');
try { mkdirSync(AGENT_LOG_DIR, { recursive: true }); } catch { /* ignore */ }

/**
 * Spawn `claude -p --output-format stream-json --verbose` and persist every
 * event as it streams. Returns the final `result` text so parseResult() still
 * validates the agent's structured summary.
 *
 * Side effects:
 *  - Each JSON line is written to agent_job_events (via appendEvent).
 *  - Raw stderr is appended to storage/agent-logs/<jobId>.err.log.
 *  - Subscribers on SSE /api/admin/jobs/:id/events?stream=1 receive events live.
 */
function spawnAgent(jobId, prompt, agentRole = 'unknown', cwd = PROJECT_ROOT) {
  // Cheap-tier harness routing:
  //   DRIVER_<AGENT>=mini   → mini-swe-agent × Qwen3 (preferred — empirical
  //                           canary 2026-05-09 showed 40s, ~$0.002, real
  //                           commit; goose was 17min, $3-5, no commit)
  //   DRIVER_<AGENT>=goose  → legacy goose path, kept for fallback only
  //   anything else         → Claude (Anthropic, default)
  // FORCE_TIER=opus globally overrides everything to Claude.
  if (shouldUseMiniSwe(agentRole)) {
    return spawnMiniSwe({
      jobId, prompt, agentRole, cwd,
      activeProcesses, agentLogDir: AGENT_LOG_DIR,
    });
  }
  if (shouldUseGoose(agentRole)) {
    return spawnGoose({
      jobId, prompt, agentRole, cwd,
      activeProcesses, agentLogDir: AGENT_LOG_DIR,
    });
  }
  return new Promise((resolve, reject) => {
    // --strict-mcp-config + --mcp-config: pin the ephemeral's MCP set to
    // the worker-specific config (no `telegram` entry), ignoring the
    // ambient ~/.mcp.json. Without this, every ephemeral claude starts a
    // bun telegram-multi/server.ts of its own → N pollers on the same bot
    // tokens → 409 Conflict on getUpdates → Shelly goes deaf on Telegram.
    // Workers push outbound notifs through notifyJob() (sendMessage, no
    // poll), so they have no business loading the polling plugin.
    const MCP_CONFIG = process.env.WORKER_MCP_CONFIG
      || join(process.env.HOME || '/home/deploy', '.mcp-worker.json');

    const model = selectClaudeModel(agentRole);
    const argv = [
      '-p', prompt,
      '--strict-mcp-config',
      '--mcp-config', MCP_CONFIG,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions'
    ];
    if (model) argv.splice(2, 0, '--model', model);

    const proc = spawn('claude', argv, {
      cwd,
      env: {
        ...process.env,
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

    const events = [];
    const parser = createStreamParser(({ seq, event }) => {
      events.push(event);
      const { event_type, event_subtype } = classifyEvent(event);
      // Fire-and-forget: the stream parser callback is sync, and `seq` is
      // monotonic so out-of-order persistence is harmless (listEvents sorts
      // by seq). Errors are surfaced to stderr but don't abort the stream —
      // a transient pg hiccup shouldn't kill an agent mid-run.
      appendEvent({ job_id: String(jobId), seq, event_type, event_subtype, payload: event })
        .catch(err => console.error('[worker] appendEvent failed', seq, err.message));
    });

    const errLogPath = join(AGENT_LOG_DIR, `${jobId}.err.log`);
    const errStream = createWriteStream(errLogPath, { flags: 'a' });
    let stderrTail = '';

    proc.stdout.on('data', (chunk) => parser.push(chunk));
    proc.stderr.on('data', (chunk) => {
      errStream.write(chunk);
      stderrTail += chunk.toString();
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
    });

    proc.on('close', (code) => {
      activeProcesses.delete(jobId);
      parser.flush();
      errStream.end();
      broadcastDone(String(jobId), { exit_code: code, events: events.length });
      if (code === 0) {
        resolve(getFinalResultText(events));
      } else {
        reject(new Error(`claude -p exited with code ${code}\nstderr: ${stderrTail.slice(-1000)}`));
      }
    });

    proc.on('error', (err) => {
      activeProcesses.delete(jobId);
      errStream.end();
      broadcastDone(String(jobId), { exit_code: null, error: err.message });
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

    if (jobData.agent === 'bootstrap') {
      const { handleBootstrapProject } = await import('./handlers/bootstrap-project.js');
      return handleBootstrapProject({ id: job.id, data: jobData });
    }

    if (jobData.agent === 'shelly_digest') {
      const { handleShellyDigest } = await import('./handlers/shelly-digest.js');
      const startedAt = Date.now();
      const result = await handleShellyDigest(jobData);
      // No runAutomation here — the digest handler already notified;
      // running the workflow engine on a non-workflow job would just no-op.
      return result;
    }

    if (jobData.agent === 'pr_scanner') {
      const { handlePrScanner } = await import('./handlers/pr-scanner.js');
      return handlePrScanner(jobData);
    }

  // Enrich work_item from Plane REST when the payload only carries the ID.
  // Engine-resumed jobs (replan → re-enqueue) and cron dispatches only know
  // plane.work_item_id; agents therefore lose all task context. Bypasses
  // plane-mcp's pydantic deserialisation bug entirely.
  await enrichWorkItemFromPlane(jobData);

  // DEVPA-144: per-job git worktree isolation for coding agents.
  // Non-coding agents (pm/architect/designer/deploy) run in PROJECT_ROOT
  // because they don't touch the working tree. Reviewer/QA reuse the
  // builder's branch via context.branch, in their own worktree, so a
  // dirty checkout from a sibling job can't leak into their diff.
  //
  // context.project_root is set by enqueueWorkflowStart from the Plane
  // project_id → projects.local_path lookup. Falls back to PROJECT_ROOT
  // for jobs dispatched without a Plane project (legacy enqueue_job paths)
  // — those still target the dev-panel repo by design.
  const repoRoot = jobData.context?.project_root || PROJECT_ROOT;
  let worktree = null;
  try {
    worktree = await prepareWorktree(jobData.job_id, {
      agent: jobData.agent,
      workItem: jobData.work_item || {},
      sequenceId: jobData.work_item?.sequence_id,
      projectIdentifier: jobData.plane?.project_identifier,
      workItemId: jobData.plane?.work_item_id,
      branch: jobData.context?.branch,  // reuse if set (reviewer/qa retreat)
      repoRoot
    });
  } catch (err) {
    // Worktree setup failure is fatal for coding agents — running them in
    // PROJECT_ROOT alongside other concurrent jobs is exactly the bug we're
    // fixing. Fail loudly so the job retries with a clean slate.
    if (shouldUseWorktree(jobData.agent)) {
      // On the FINAL attempt, mark the workflow_instance as 'failed' so a
      // fresh re-dispatch can land cleanly. Without this, the row stays in
      // its previous status (typically 'running') and re-dispatch hits the
      // unique-partial-index 'already_running' guard, requiring a manual
      // SQL cancel. Best-effort — never let a DB hiccup mask the real error.
      const isFinalAttempt = (job.attemptsMade + 1) >= (job.opts.attempts || 1);
      if (isFinalAttempt && jobData.workflow && jobData.plane?.work_item_id) {
        try {
          await updateInstance(
            { work_item_id: jobData.plane.work_item_id, workflow_name: jobData.workflow },
            { status: 'failed', last_job_id: jobData.job_id }
          );
        } catch (e) {
          console.warn(`[Worker] failed to mark instance failed after worktree error: ${e.message}`);
        }
      }
      throw err;
    }
  }

  if (worktree) {
    jobData.context = {
      ...(jobData.context || {}),
      worktree_path: worktree.path,
      branch: worktree.branch
    };
  }

  // Build prompt (now sees worktree_path + branch in context). When the
  // goose harness will run this job, skip the SOUL section — goose-driver
  // delivers SOUL to the model via .goosehints written to the worktree
  // root, so bundling it into recipe.instructions would double-ship it.
  const useGoose = shouldUseGoose(jobData.agent);
  const prompt = buildPrompt(jobData, { skipSoul: useGoose });

  const startedAt = Date.now();

  // Emit job.started to admin SSE (non-blocking)
  if (process.env.ADMIN_API_KEY) {
    fetch(process.env.WORKER_EVENTS_URL || 'http://localhost:3030/api/admin/events/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': process.env.ADMIN_API_KEY },
      body: JSON.stringify({ event: 'job.started', data: { job_id: jobData.job_id, agent: jobData.agent, work_item_id: jobData.plane?.work_item_id, worktree: worktree?.path || null, branch: worktree?.branch || null } })
    }).catch(() => {});
  }

  try {
    // Spawn agent in the worktree if there is one. Otherwise spawn in the
    // resolved repoRoot — non-coding agents (pm/architect/designer) on
    // cross-project work still need to be IN the target repo so any tools
    // that shell out (cat, grep) find the right files.
    const output = await spawnAgent(jobData.job_id, prompt, jobData.agent, worktree?.path || repoRoot);

    // Parse result (strict: returns { ok, data } | { ok: false, error })
    const parsed = parseResult(output);
    if (!parsed.ok) {
      await logStep({ job_id: jobData.job_id, agent: jobData.agent, step: 'parseResult',
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
    await logStep({ job_id: jobData.job_id, agent: jobData.agent, step: 'parseResult', status: 'ok' });

    await runAutomation({ jobData, result: parsed.data, startedAt });

    const result = {
      ...parsed.data,
      agent,
      task_id: task?.id || null,
      raw_length: output.length
    };

    console.log(`[Worker] Job ${job.id} completed — ${result.summary?.slice(0, 100)}`);

    return result;
  } finally {
    // Cleanup runs even on parseResult/spawn failures. Push + PR already
    // happened inside the worktree by this point (publishWorkItem ran
    // through runAutomation), so removing the worktree is safe.
    if (worktree) {
      try { await worktree.cleanup(); }
      catch (err) { console.warn(`[Worker] worktree cleanup failed for ${job.id}: ${err.message}`); }
    }
  }

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

// Connect to the services-VPS agent hub so every workflow_instance and
// agent_job_log write streams live to the dashboard instead of waiting
// for the next poll cycle. Postgres still gets the durable record;
// socket.io is now the bus.
import('./agent-hub-client.js').then(m => m.connectAgentHub()).catch(
  err => console.warn('[agent-hub-client] not connected:', err.message)
);

// Export for api.js
export { activeProcesses, worker, getMode };

// Start worker API server
import('./api.js').catch(err => console.error('[Worker API] Failed to start:', err));
