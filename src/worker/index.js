// src/worker/index.js
import { Worker } from 'bullmq';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from 'fs';
import { join } from 'path';
import { buildPrompt, parseResult } from './prompt-builder.js';
import { createStreamParser, getFinalResultText, classifyEvent } from './stream-parser.js';
import { appendEvent, broadcastDone } from '../server/jobs-events.js';
import { recordHarnessEvent } from './harness-telemetry.js';
import { QUEUES, PRIORITY_MAP, getQueue } from '../server/bullmq.js';
import { registerCrons } from './crons.js';
import { startBacklogPuller } from './backlog-puller.js';
import { startReaper } from './reaper.js';
import {
  classifyPreSpawnError, classifyEnvelopeFailure,
  decideInfraRetry, decideEnvelopeRetry, buildEnvelopeFeedback
} from './failure-classifier.js';
import { agentTimeoutMs, stallTimeoutMs, budgetTokensFor, killGraceMs, computeLockDurationMs, checkLockDurationInvariant } from './timeout-policy.js';
import { createProcessTimeoutController } from './process-timeout-controller.js';
import { createUsageAccumulator, isBudgetExceeded } from './token-usage.js';
import { reconcileOnBoot, killOrphanedSpawnProcesses } from './boot-reconciler.js';
import { execSync } from 'child_process';

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
import { runAutomation, rescueWorktreeOnParseFailure } from './automation.js';
import { logStep } from '../server/jobs-log.js';
import { notifyJob } from '../server/alerts.js';
import { initMasterDatabase } from '../server/db.js';
import { prepareWorktree, shouldUseWorktree } from './worktree.js';
import { updateInstance } from '../server/workflow-instances.js';
import { spawnGoose, shouldUseGoose } from './goose-driver.js';
import { spawnMiniSwe, shouldUseMiniSwe } from './mini-swe-driver.js';
import { spawnPi, shouldUsePi } from './pi-driver.js';
import { spawnContainer, shouldUseContainer } from './container-driver.js';
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

// Engine contract §4.2 — the worker's own re-enqueue path. BullMQ now runs
// the agents queue at attempts=1 (src/server/bullmq.js), so infra_failure
// retries and the single envelope-retry-with-feedback are no longer BullMQ's
// job; the worker decides and re-enqueues explicitly. Kept as a reassignable
// binding so tests can substitute a spy.
let _reenqueue = async (payload) => {
  const queue = getQueue(QUEUES.agents);
  const prio = PRIORITY_MAP[payload.priority || 'p2'] || 10;
  const name = `${payload.agent}:${payload.plane?.work_item_id || 'adhoc'}`;
  return queue.add(name, payload, { priority: prio });
};
export function __setReenqueueForTests(fn) { _reenqueue = fn; }

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
function spawnAgent(jobId, prompt, agentRole = 'unknown', cwd = PROJECT_ROOT, meta = {}) {
  // Routing is two orthogonal axes:
  //   1. WHETHER to containerize (isolation): shouldUseContainer wins first
  //      so per-job docker isolation wraps the model choice. The container
  //      driver reads CONTAINER_INNER_DRIVER=claude|pi to pick which CLI
  //      runs inside.
  //   2. WHICH CLI to run natively (no container):
  //        DRIVER_<AGENT>=mini   → mini-swe-agent × Qwen3
  //        DRIVER_<AGENT>=pi     → pi × Qwen3 via DeepInfra
  //        DRIVER_<AGENT>=goose  → legacy goose path
  //        anything else         → Claude Code (default)
  // FORCE_TIER=opus globally overrides everything to native Claude.
  if (shouldUseContainer(agentRole)) {
    return spawnContainer({
      jobId, prompt, agentRole, cwd,
      activeProcesses, agentLogDir: AGENT_LOG_DIR, meta,
    });
  }
  if (shouldUseMiniSwe(agentRole)) {
    return spawnMiniSwe({
      jobId, prompt, agentRole, cwd,
      activeProcesses, agentLogDir: AGENT_LOG_DIR,
    });
  }
  if (shouldUsePi(agentRole)) {
    return spawnPi({
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
      // Engine contract §5: kill must target the whole process GROUP
      // (claude -p can fork MCP server subprocesses), not just the direct
      // child. `detached: true` on POSIX puts the child in its own process
      // group (pid becomes the group id), so process-timeout-controller.js
      // can `process.kill(-pid, signal)` to reach every descendant.
      detached: true,
      env: {
        ...process.env,
        JOB_ID: jobId,
        AGENT_ROLE: agentRole,
        // HITL context for the await_human MCP tool. When set, the tool
        // can flip workflow_instances.status to 'awaiting_input' on
        // pause and back to 'running' on resume. When absent, the tool
        // still works at the inbox level but can't drive the workflow
        // state machine.
        ...(meta.work_item_id ? { WORK_ITEM_ID: meta.work_item_id } : {}),
        ...(meta.workflow_name ? { WORKFLOW_NAME: meta.workflow_name } : {}),
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

    // Engine contract §5/§6 — stall detection, wall-clock timeout, and
    // token-budget enforcement. `killInfo` is set synchronously by
    // onKill/onBudgetKill BEFORE the process actually dies, so the
    // proc.on('close', ...) handler below can reject with a classified
    // reason instead of a generic non-zero-exit error.
    let killInfo = null; // { reason: 'stall' | 'wall_clock' | 'budget' }
    const usage = createUsageAccumulator();
    const budgetTokens = budgetTokensFor(agentRole);
    const timeoutController = createProcessTimeoutController({
      proc,
      wallClockMs: agentTimeoutMs(agentRole),
      stallMs: stallTimeoutMs(),
      graceMs: killGraceMs(),
      onKill: (info) => { killInfo = info; },
    });

    const events = [];
    // Gap #1 (2026-05-25): tool-error feedback loop. Count tool_result errors
    // streamed by the agent. When the count crosses WORKER_TOOL_ERROR_THRESHOLD
    // (default 5), emit one synthetic system event so workflows can react via
    // the `tool_errors_excessive` predicate. Final count is attached to the
    // resolved result so predicates can read it without DB lookup.
    const TOOL_ERR_THRESHOLD = parseInt(process.env.WORKER_TOOL_ERROR_THRESHOLD || '5', 10);
    let toolErrorCount = 0;
    let toolErrorThresholdEmitted = false;
    let syntheticSeq = 1_000_000_000; // far above natural stream seqs
    const parser = createStreamParser(({ seq, event }) => {
      events.push(event);
      const { event_type, event_subtype } = classifyEvent(event);
      // §5: any driver event resets the stall window — the agent is alive.
      timeoutController.recordEvent();
      // §6: accumulate token usage on every event that carries it; kill as
      // soon as the running total crosses the role's budget. Checked here
      // (not on a timer) so the kill fires on the very event that crosses
      // the line, not up to a poll-interval late.
      usage.record(event);
      if (!killInfo && isBudgetExceeded(usage.total(), budgetTokens)) {
        killInfo = { reason: 'budget', tokens: usage.total(), budgetTokens };
        timeoutController.stop();
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch { /* gone */ } }
      }

      // Fire-and-forget: the stream parser callback is sync, and `seq` is
      // monotonic so out-of-order persistence is harmless (listEvents sorts
      // by seq). Errors are surfaced to stderr but don't abort the stream —
      // a transient pg hiccup shouldn't kill an agent mid-run.
      appendEvent({ job_id: String(jobId), seq, event_type, event_subtype, payload: event })
        .catch(err => console.error('[worker] appendEvent failed', seq, err.message));

      if (event_type === 'tool_result' && event_subtype === 'error') {
        toolErrorCount++;
        if (!toolErrorThresholdEmitted && toolErrorCount >= TOOL_ERR_THRESHOLD) {
          toolErrorThresholdEmitted = true;
          const payload = {
            count: toolErrorCount,
            threshold: TOOL_ERR_THRESHOLD,
            jobId: String(jobId),
            agentRole
          };
          appendEvent({
            job_id: String(jobId),
            seq: syntheticSeq++,
            event_type: 'system',
            event_subtype: 'tool_error_threshold',
            payload
          }).catch(err => console.error('[worker] tool_error_threshold appendEvent failed', err.message));
        }
      }
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
      timeoutController.stop();
      parser.flush();
      errStream.end();
      // Gap #2 telemetry: surface stream-parser line failures so a job that
      // reports done despite a chunk of corrupt JSON is visible on the
      // dashboard timeline (rather than only in console.warn → systemd).
      try {
        const stats = parser.stats();
        if (stats.malformed > 0) {
          recordHarnessEvent({
            jobId,
            harness: 'claude',
            kind: 'parser_warning',
            reason: 'malformed_stream_lines',
            detail: { count: stats.malformed, total: stats.total },
          });
        }
      } catch { /* telemetry is best-effort */ }
      broadcastDone(String(jobId), { exit_code: code, events: events.length, kill_reason: killInfo?.reason || null });
      if (killInfo) {
        // Engine contract §5/§6 — the kill preempted whatever exit code the
        // process would otherwise have produced. Classify explicitly so the
        // caller (spawnAgent's caller in the worker job processor) sees
        // agent_failure/{stall,timeout,budget} instead of a generic
        // non-zero-exit crash. The worktree is left untouched — the
        // finally-block cleanup in the job processor still runs the rescue
        // path against whatever diff exists.
        const err = new Error(
          killInfo.reason === 'stall'
            ? `agent stalled: no driver event for ${stallTimeoutMs()}ms`
            : killInfo.reason === 'budget'
              ? `agent exceeded token budget: ${killInfo.tokens} > ${killInfo.budgetTokens}`
              : `agent exceeded wall-clock timeout: ${agentTimeoutMs(agentRole)}ms`
        );
        err.failure_class = 'agent_failure';
        err.reason = killInfo.reason;
        reject(err);
      } else if (code === 0) {
        // Gap #1: return text + toolErrorCount. The caller normalizes
        // (drivers other than Claude still resolve a string) and stashes
        // the count on parsed.data for the `tool_errors_excessive` predicate.
        resolve({ output: getFinalResultText(events), toolErrorCount });
      } else {
        reject(new Error(`claude -p exited with code ${code}\nstderr: ${stderrTail.slice(-1000)}`));
      }
    });

    proc.on('error', (err) => {
      activeProcesses.delete(jobId);
      timeoutController.stop();
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
  // Set true when this attempt scheduled a retry (infra or envelope) that
  // reuses the SAME worktree/branch — cleanup must be skipped so the retry
  // has something to resume. Normal completion and terminal failure paths
  // leave this false and the finally block cleans up as before.
  let skipWorktreeCleanup = false;
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
    // Worktree setup failure happens BEFORE the agent ever ran — engine
    // contract §4.2 classifies this as infra_failure (spawn/clone/fetch
    // impossible), never agent_failure. It gets its own bounded retry
    // (MAX_INFRA_RETRIES=2, engine-owned since BullMQ's own attempts is now
    // 1 for this queue — src/server/bullmq.js), not a blind BullMQ retry.
    if (shouldUseWorktree(jobData.agent)) {
      const { reason } = classifyPreSpawnError(err);
      const infraRetryCount = jobData.infra_retry_count || 0;
      const { shouldRetry } = decideInfraRetry(infraRetryCount);

      if (shouldRetry) {
        console.warn(`[Worker] infra_failure (worktree) on job ${jobData.job_id}, retry ${infraRetryCount + 1}/2: ${reason}`);
        try {
          await _reenqueue({ ...jobData, infra_retry_count: infraRetryCount + 1 });
          // The retry is now queued under a new BullMQ job id; let THIS
          // attempt end quietly (no throw) so BullMQ doesn't also count it
          // as a failure against a queue that already has attempts=1.
          return { status: 'infra_retry_scheduled', reason };
        } catch (reenqueueErr) {
          console.warn(`[Worker] infra retry re-enqueue failed, falling through to terminal failure: ${reenqueueErr.message}`);
          // fall through to terminal handling below
        }
      }

      // Retries exhausted (or re-enqueue itself failed) — terminal.
      // On the FINAL attempt, mark the workflow_instance as 'failed' so a
      // fresh re-dispatch can land cleanly. Without this, the row stays in
      // its previous status (typically 'running') and re-dispatch hits the
      // unique-partial-index 'already_running' guard, requiring a manual
      // SQL cancel. Best-effort — never let a DB hiccup mask the real error.
      if (jobData.workflow && jobData.plane?.work_item_id) {
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
    let spawnResult;
    try {
      spawnResult = await spawnAgent(
        jobData.job_id,
        prompt,
        jobData.agent,
        worktree?.path || repoRoot,
        {
          work_item_id: jobData.plane?.work_item_id || null,
          workflow_name: jobData.workflow || null,
        }
      );
    } catch (spawnErr) {
      // Engine contract §4.3 — every arrival in a terminal state notifies,
      // and §5/§6 kills preserve whatever diff exists via rescue, exactly
      // like the parseResult-failure path below. Without this catch, a
      // stall/timeout/budget kill (spawnErr.failure_class set by spawnAgent
      // in the Claude branch) or any other spawn crash bypassed both rescue
      // AND notification — the job just died silently into BullMQ's own
      // 'failed' event with no work-item context.
      const reason = spawnErr.reason
        || (spawnErr.failure_class ? spawnErr.failure_class : null)
        || spawnErr.message;
      let rescue = { rescued: false };
      try {
        rescue = rescueWorktreeOnParseFailure({
          jobData, output: '', parseError: `spawn failed: ${reason}`
        });
      } catch (e) {
        console.warn(`[Worker] rescue threw after spawn failure for job ${jobData.job_id}: ${e.message}`);
      }
      await logStep({ job_id: jobData.job_id, agent: jobData.agent, step: 'spawnAgent',
                status: 'error', error: spawnErr.message });
      const rescueNote = rescue.rescued
        ? ` rescued: ${rescue.pr_url}`
        : (rescue.reason ? ` no_rescue:${rescue.reason}` : '');
      await notifyJob({
        job_id: jobData.job_id, agent: jobData.agent,
        work_item_id: jobData.plane?.work_item_id || jobData.task?.id,
        title: jobData.work_item?.title || jobData.task?.title,
        status: 'failed',
        extra: `${spawnErr.failure_class || 'agent_failure'}:${reason}${rescueNote}`
      });
      throw spawnErr;
    }

    // Gap #1 (2026-05-25): the Claude branch of spawnAgent now resolves
    // { output, toolErrorCount }. Other drivers (goose/pi/mini-swe/container)
    // still resolve a plain string — normalize both shapes so this code
    // path stays backwards-compatible while we extend the rest later.
    const output = typeof spawnResult === 'string' ? spawnResult : spawnResult.output;
    const toolErrorCount = typeof spawnResult === 'string' ? 0 : (spawnResult.toolErrorCount || 0);

    // Parse result (strict: returns { ok, data } | { ok: false, error })
    const parsed = parseResult(output);
    if (!parsed.ok) {
      const { reason: envelopeReason } = classifyEnvelopeFailure(parsed.error);
      const envelopeRetriesUsed = jobData.envelope_retry_count || 0;
      const { shouldRetry: shouldRetryEnvelope } = decideEnvelopeRetry(envelopeRetriesUsed);

      // Engine contract §4.2 — the ONE retry-with-feedback. The agent ran
      // and produced output, it just didn't close with a valid envelope;
      // hand back the exact validation error + schema and try exactly once
      // more before falling to rescue+fail. Only meaningful when there's a
      // worktree to keep working in (non-coding agents never hit parseResult
      // failures from a missing envelope in the same way, but guard anyway).
      if (shouldRetryEnvelope) {
        console.warn(`[Worker] ${envelopeReason} on job ${jobData.job_id}, retry-with-feedback (1/1): ${parsed.error}`);
        await logStep({ job_id: jobData.job_id, agent: jobData.agent, step: 'parseResult',
                  status: 'error', error: `${parsed.error} (retrying with feedback)` });
        try {
          await _reenqueue({
            ...jobData,
            envelope_retry_count: envelopeRetriesUsed + 1,
            context: {
              ...(jobData.context || {}),
              // worktree_path/branch are per-spawn; the retry keeps the SAME
              // worktree/branch so the agent's partial work isn't discarded.
              retry_feedback: buildEnvelopeFeedback(parsed.error)
            }
          });
          // Do not clean up the worktree for this attempt — the retry reuses
          // it (context carries the same worktree_path/branch forward).
          skipWorktreeCleanup = true;
          return { status: 'envelope_retry_scheduled', reason: envelopeReason };
        } catch (reenqueueErr) {
          console.warn(`[Worker] envelope retry re-enqueue failed, falling through to rescue+fail: ${reenqueueErr.message}`);
          // fall through to rescue+fail below
        }
      }

      // Rescue first, throw second. The agent may have done real work in the
      // worktree even without emitting the closing JSON; the finally block
      // below will delete the worktree shortly, so this is our only chance
      // to preserve a diff as a review PR. The throw still marks the BullMQ
      // job failed so telemetry is honest — the rescue PR is an artifact for
      // a human to triage, not a "success".
      let rescue = { rescued: false };
      try {
        rescue = rescueWorktreeOnParseFailure({
          jobData, output, parseError: parsed.error
        });
      } catch (e) {
        console.warn(`[Worker] rescue threw for job ${jobData.job_id}: ${e.message}`);
      }
      await logStep({ job_id: jobData.job_id, agent: jobData.agent, step: 'parseResult',
                status: 'error', error: parsed.error });
      const rescueNote = rescue.rescued
        ? ` rescued: ${rescue.pr_url}`
        : (rescue.reason ? ` no_rescue:${rescue.reason}` : '');
      await notifyJob({
        job_id: jobData.job_id, agent: jobData.agent,
        work_item_id: jobData.plane?.work_item_id || jobData.task?.id,
        title: jobData.work_item?.title || jobData.task?.title,
        status: 'failed',
        extra: `parseResult: ${parsed.error}${rescueNote}`
      });
      throw new Error(`parseResult failed: ${parsed.error}`);
    }
    await logStep({ job_id: jobData.job_id, agent: jobData.agent, step: 'parseResult', status: 'ok' });

    // Gap #1: thread the tool-error count through to the workflow engine so
    // predicates (e.g. tool_errors_excessive) can branch on it. Read by
    // src/worker/predicates.js#tool_errors_excessive.
    parsed.data.tool_error_count = toolErrorCount;

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
    // Cleanup runs even on parseResult/spawn failures. On the success path,
    // runAutomation already ran publishWorkItem (push + PR). On parseResult
    // failure, the rescue path above already pushed + opened a review PR.
    // Either way the worktree's contents are preserved remotely before we
    // delete the local copy here. Exception: a scheduled infra/envelope
    // retry (§4.2) reuses this same worktree/branch — skip cleanup so the
    // retried attempt has something to resume instead of re-cloning.
    if (worktree && !skipWorktreeCleanup) {
      try { await worktree.cleanup(); }
      catch (err) { console.warn(`[Worker] worktree cleanup failed for ${job.id}: ${err.message}`); }
    }
  }

}, {
  connection,
  concurrency: CONCURRENCY,
  stalledInterval: 120000,
  // Engine contract §5 invariant: lockDuration must exceed max(role
  // timeouts) + 5 min, or BullMQ's lock can expire before the worker's own
  // kill fires — opening the door to double-dispatch on the same job.
  // Derived from timeout-policy.js so a future AGENT_TIMEOUT_<ROLE>_MS bump
  // can't silently violate the invariant again (previously hardcoded
  // 1_800_000 — happened to satisfy it, by luck rather than by construction).
  lockDuration: computeLockDurationMs(),
  // Engine contract §8: reconciliation must run BEFORE the queue is
  // consumed. autorun:false constructs the Worker (so its `.opts` and event
  // listeners exist for the invariant check + pipeline handlers below)
  // without starting job processing; runBootReconciliation() at the bottom
  // of this file calls worker.run() once reconciliation completes.
  autorun: false
});

// Defensive startup assertion — belt-and-braces even though lockDuration is
// now DERIVED FROM the same role-timeout table (so it cannot drift out of
// sync with itself). Guards against a future direct override of the Worker
// options that reintroduces a hardcoded, unchecked value.
{
  const { ok, minRequiredMs } = checkLockDurationInvariant(worker.opts.lockDuration);
  if (!ok) {
    console.error(
      `[Worker] FATAL: lockDuration invariant violated — lockDuration=${worker.opts.lockDuration}ms ` +
      `must exceed max(role timeouts)+5min=${minRequiredMs}ms. Refusing to start.`
    );
    process.exit(1);
  }
}

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

// Réconcilie les workflow_instances fantômes (jobs morts sans transition).
startReaper();

// Connect to the services-VPS agent hub so every workflow_instance and
// agent_job_log write streams live to the dashboard instead of waiting
// for the next poll cycle. Postgres still gets the durable record;
// socket.io is now the bus.
import('./agent-hub-client.js').then(m => {
  m.connectAgentHub();
  // Wire the same cancel handler the Redis worker:control subscriber below
  // uses, so a cancel delivered over the socket.io hub (if that connection
  // happens to be up) also works — see the comment in agent-hub-client.js.
  m.wireCancelHandler(activeProcesses);
}).catch(
  err => console.warn('[agent-hub-client] not connected:', err.message)
);

// Engine contract §7 — cancel channel. Redis pub/sub on `worker:control` is
// the PRIMARY cancel path (replaces the socket.io admin:command stub that
// used to sit here unimplemented). Uses a dedicated Redis connection —
// ioredis subscriber connections can only issue pub/sub commands once
// `.subscribe()` is called, so this can't share `connection` above (BullMQ
// needs that one free for normal commands). `POST /kill/:jobId` (worker
// api.js) remains as the local HTTP fallback the cancel_job capability
// falls back to if pub/sub delivery can't be confirmed.
const controlSubscriber = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});
import('./worker-control.js').then(({ subscribeWorkerControl, createCancelHandler }) =>
  subscribeWorkerControl(controlSubscriber, createCancelHandler(activeProcesses))
).then(
  () => console.log('[Worker] subscribed to worker:control for cancel'),
  err => console.warn('[worker-control] subscribe failed:', err.message)
);

// Export for api.js
export { activeProcesses, worker, getMode };

// Start worker API server
import('./api.js').catch(err => console.error('[Worker API] Failed to start:', err));

// ============================================================================
// BOOT RECONCILIATION (§8) — runs before the queue is consumed
// ============================================================================
//
// Engine contract §8: "Au boot, avant de consommer la queue, le worker
// exécute la réconciliation." The Worker above was constructed with
// autorun:false specifically so this can run first — worker.run() (last
// line of this block) is what actually starts job processing.
//
// listSpawnSignaturePids uses pgrep to find claude -p / pi / docker run
// processes tagged with our own JOB_ID env marker that ISN'T anything this
// fresh process knows about (activeProcesses is empty at this point by
// construction — nothing has been dispatched yet). Best-effort: pgrep may
// not exist on all hosts (macOS dev boxes have it via BSD userland, but the
// pattern below still degrades to "found nothing" rather than throwing).
function listSpawnSignaturePids() {
  try {
    const out = execSync('pgrep -f "JOB_ID=" 2>/dev/null || true', { encoding: 'utf8' });
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function bootReconcileAndStart() {
  try {
    killOrphanedSpawnProcesses({
      listSpawnSignaturePids,
      killPid: (pid) => process.kill(Number(pid), 'SIGKILL'),
    });
  } catch (err) {
    console.warn('[Worker] killOrphanedSpawnProcesses threw:', err.message);
  }

  try {
    const { listLiveInstances, updateInstance: updateInst } = await import('../server/workflow-instances.js');
    await reconcileOnBoot({
      queue: getQueue(QUEUES.agents),
      listLiveInstances,
      updateInstance: updateInst,
      notify: (msg) => {
        notifyJob({
          job_id: null, agent: 'worker',
          work_item_id: null, title: 'boot reconciliation',
          status: 'done', extra: msg,
        }).catch(() => {});
      },
    });
  } catch (err) {
    console.error('[Worker] reconcileOnBoot threw (starting queue anyway):', err.message);
  }

  await worker.run();
  console.log('[Worker] queue consumption started');
}

bootReconcileAndStart().catch(err => {
  console.error('[Worker] FATAL: bootReconcileAndStart failed:', err);
  process.exit(1);
});
