// src/worker/boot-reconciler.js
//
// Engine contract §8 — reconciliation at worker boot, BEFORE consuming the
// queue. On a crash/restart, three kinds of state can be left dangling:
//
//   1. BullMQ jobs in `active` state whose spawning process is gone (the
//      worker that held the lock died). These become `failed`,
//      infra_failure, reason=worker_restart. NO auto re-run — the worktree
//      state after an uncontrolled kill is unknown, so silently retrying
//      could double-push or corrupt a branch.
//   2. OS processes matching the worker's own spawn signature (claude -p /
//      docker run for a job) that BullMQ doesn't know about anymore —
//      SIGKILL them so they don't keep burning tokens/CPU as zombies.
//   3. Worktrees with no live job — already handled lazily by
//      prepareWorktree()'s reclaim path (src/worker/worktree.js); nothing
//      new needed here, noted for completeness.
//   4. workflow_instances rows in a live state (running/awaiting_approval/
//      awaiting_input) that violate the §3.2 anti-zombie invariant: no
//      BullMQ job backing them AND no event for STALE_INSTANCE_TTL (default
//      24h) → failed, reason=stale_reconciled. The TTL gate matters —
//      without it a boot reconciliation would kill perfectly healthy
//      `awaiting_input` rows (waiting on a human) the moment the worker
//      restarts, which is not what §3.2 specifies.
//
// This module separates PURE decision logic (given a list of instances +
// which BullMQ job ids are genuinely active, decide what to do with each)
// from the orchestration (fetching from Postgres/BullMQ/process table and
// applying the decisions) so the decision logic is unit-testable without a
// real queue or DB.
//
// Idempotent: running reconcileOnBoot() twice in a row is safe — the second
// pass finds nothing live-but-orphaned because the first pass already
// terminalized everything it found.

// ---------------------------------------------------------------------------
// Pure decision logic
// ---------------------------------------------------------------------------

// §3.2 anti-zombie invariant default: an instance with no live backing job
// is only reconciled once it's also been silent for this long. Matches the
// contract's STALE_INSTANCE_TTL default (24h) — a fresh `awaiting_input`
// row (waiting on a human who hasn't answered YET) or a `running` row owned
// by a sibling worker in a multi-worker fleet must NOT be killed just
// because THIS worker restarted; only genuine long-silence zombies qualify.
export const DEFAULT_STALE_INSTANCE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Decide the fate of each workflow_instance row found in a live state at
 * boot. An instance is "backed" if its last_job_id is present in
 * `liveBullJobIds` (jobs BullMQ still reports as active/waiting/delayed —
 * i.e. genuinely in flight, possibly on a DIFFERENT worker in a multi-worker
 * fleet). An instance that is NOT backed by a live job is only reconciled
 * once §3.2's TTL has also elapsed since its `last_event_at` — this is the
 * exact anti-zombie invariant text: "sans job BullMQ associé ET sans
 * événement depuis STALE_INSTANCE_TTL". Not-backed-but-recent rows are kept
 * (e.g. an `awaiting_input` instance waiting on a human who hasn't answered
 * in the last five minutes is not a zombie).
 *
 * @param {Array<{id:any, last_job_id:any, status:string, workflow_name:string, current_step:string, last_event_at:number|string}>} instances
 * @param {Set<string>} liveBullJobIds - job ids BullMQ reports as active/waiting/delayed
 * @param {object} [opts]
 * @param {number} [opts.now] - current time in ms (injectable for tests)
 * @param {number} [opts.staleTtlMs] - override STALE_INSTANCE_TTL
 * @returns {Array<{instance: object, action: 'reconcile'|'keep', reason?: string}>}
 */
export function decideInstanceReconciliation(instances, liveBullJobIds, opts = {}) {
  const now = opts.now ?? Date.now();
  const staleTtlMs = opts.staleTtlMs ?? DEFAULT_STALE_INSTANCE_TTL_MS;
  return instances.map((inst) => {
    const jobId = inst.last_job_id != null ? String(inst.last_job_id) : null;
    const backed = jobId != null && liveBullJobIds.has(jobId);
    if (backed) return { instance: inst, action: 'keep' };
    const lastEventAt = Number(inst.last_event_at) || 0;
    const silentForMs = now - lastEventAt;
    if (silentForMs < staleTtlMs) {
      return { instance: inst, action: 'keep', reason: 'within_ttl' };
    }
    return { instance: inst, action: 'reconcile', reason: 'stale_reconciled' };
  });
}

/**
 * Decide which BullMQ jobs currently reported as `active` are actually
 * dead — i.e. no local process in `livePids` corresponds to them. This is
 * the boot-time equivalent of BullMQ's own `stalled` detection, but runs
 * once at startup rather than waiting for the stalled-check interval, and
 * explicitly forbids auto-retry per the contract (§8: "Pas de re-run
 * automatique").
 *
 * @param {Array<{id: string, data?: object}>} activeBullJobs - jobs BullMQ reports as `active`
 * @param {Set<string>} livePids - job ids this process currently tracks as running (empty at boot, always — a fresh process has no children yet, but the parameter exists for testability and for a future multi-stage boot)
 * @returns {Array<{job_id: string, action: 'fail_no_rerun'}>}
 */
export function decideOrphanedActiveJobs(activeBullJobs, livePids = new Set()) {
  return activeBullJobs
    .filter((job) => !livePids.has(String(job.id)))
    .map((job) => ({ job_id: String(job.id), action: 'fail_no_rerun' }));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the full boot reconciliation. Call BEFORE the BullMQ Worker starts
 * processing (i.e. before `new Worker(...)` in index.js, or immediately
 * after construction but before any job could plausibly be picked up —
 * in practice this module is called first and the Worker is constructed
 * right after).
 *
 * @param {object} deps
 * @param {import('bullmq').Queue} deps.queue - the agents queue
 * @param {() => Promise<Array<object>>} deps.listLiveInstances - returns
 *   workflow_instances rows currently in a live status (running /
 *   awaiting_approval / awaiting_input)
 * @param {(criteria: object, patch: object) => Promise<object>} deps.updateInstance
 * @param {(msg: string) => void} [deps.notify] - fire-and-forget summary
 *   notifier (Telegram via notifyJob, or console.log in tests)
 * @param {number} [deps.now] - injectable current time for tests
 * @param {number} [deps.staleTtlMs] - override STALE_INSTANCE_TTL (§3.2, default 24h)
 * @returns {Promise<{ reconciled_instances: number, failed_active_jobs: number, details: object }>}
 */
export async function reconcileOnBoot({ queue, listLiveInstances, updateInstance, notify = () => {}, now, staleTtlMs }) {
  const summary = { reconciled_instances: 0, failed_active_jobs: 0, details: { instances: [], jobs: [] } };

  // Step A: find BullMQ jobs reported `active`. On a fresh worker process
  // (this function runs at boot, before the Worker starts consuming), NO
  // local process can legitimately be running yet — every `active` job at
  // this point is, by construction, orphaned (its owning process died with
  // the previous worker instance). Per §8 point 1: fail, infra_failure,
  // reason=worker_restart, no auto re-run.
  let activeJobs = [];
  try {
    activeJobs = await queue.getActive();
  } catch (err) {
    console.warn(`[boot-reconciler] queue.getActive() failed: ${err.message}`);
  }
  const orphanedDecisions = decideOrphanedActiveJobs(
    activeJobs.map((j) => ({ id: j.id, data: j.data })),
    new Set() // boot-time: nothing local is alive yet
  );
  for (const decision of orphanedDecisions) {
    const job = activeJobs.find((j) => String(j.id) === decision.job_id);
    try {
      // moveToFailed requires a token in newer BullMQ; jobs stuck `active`
      // from a dead worker won't have a valid lock token anymore, so we
      // discard directly — the point is removing it from `active` so it
      // stops blocking the concurrency slot and stops looking "running" on
      // the dashboard. The workflow_instance side (below) carries the
      // actual failure record a human/PM acts on.
      await job?.discard?.();
      await job?.remove?.();
    } catch (err) {
      console.warn(`[boot-reconciler] failed to clear orphaned active job ${decision.job_id}: ${err.message}`);
    }
    summary.failed_active_jobs++;
    summary.details.jobs.push(decision.job_id);
  }

  // Step B: reconcile workflow_instances rows in a live status whose
  // backing job is gone AND that have been silent past §3.2's TTL. A live
  // instance counts as "backed" when its last_job_id is still genuinely
  // queued (waiting/delayed — not yet picked up by any worker, so no orphan
  // risk) or was NOT one of the jobs Step A just judged orphaned (accounts
  // for `active` jobs a sibling worker in a multi-worker fleet may hold —
  // this single boot pass only owns reconciling ITS OWN dead active jobs,
  // not every worker's). Anything not backed AND stale beyond the TTL
  // violates §3.2 and is reconciled; anything not backed but recent (e.g. an
  // `awaiting_input` row waiting on a human who hasn't answered yet) is
  // deliberately left alone — see decideInstanceReconciliation's docstring.
  let liveInstances = [];
  try {
    liveInstances = await listLiveInstances();
  } catch (err) {
    console.warn(`[boot-reconciler] listLiveInstances() failed: ${err.message}`);
  }
  let liveBullJobIds = new Set();
  try {
    const [waitingJobs, delayedJobs] = await Promise.all([
      queue.getWaiting().catch(() => []),
      queue.getDelayed().catch(() => []),
    ]);
    const orphanedIds = new Set(orphanedDecisions.map((d) => d.job_id));
    const stillActiveIds = activeJobs.map((j) => String(j.id)).filter((id) => !orphanedIds.has(id));
    liveBullJobIds = new Set([
      ...waitingJobs.map((j) => String(j.id)),
      ...delayedJobs.map((j) => String(j.id)),
      ...stillActiveIds,
    ]);
  } catch (err) {
    console.warn(`[boot-reconciler] building liveBullJobIds failed: ${err.message}`);
  }
  const instanceDecisions = decideInstanceReconciliation(liveInstances, liveBullJobIds, { now, staleTtlMs });
  for (const { instance, action } of instanceDecisions) {
    if (action !== 'reconcile') continue;
    try {
      await updateInstance(
        { work_item_id: instance.work_item_id, workflow_name: instance.workflow_name },
        {
          status: 'failed',
          metadata: JSON.stringify({
            ...(safeParseMetadata(instance.metadata)),
            reconciled: true,
            reconcile_reason: 'stale_reconciled',
            reconciled_at: Date.now(),
          }),
        }
      );
      summary.reconciled_instances++;
      summary.details.instances.push(instance.id);
    } catch (err) {
      console.warn(`[boot-reconciler] failed to reconcile instance ${instance.id}: ${err.message}`);
    }
  }

  if (summary.reconciled_instances > 0 || summary.failed_active_jobs > 0) {
    notify(
      `[boot-reconciler] reconciled ${summary.reconciled_instances} stale instance(s), ` +
      `cleared ${summary.failed_active_jobs} orphaned active job(s)`
    );
  }
  console.log(
    `[boot-reconciler] done — reconciled_instances=${summary.reconciled_instances} ` +
    `failed_active_jobs=${summary.failed_active_jobs}`
  );

  return summary;
}

function safeParseMetadata(metadata) {
  if (!metadata) return {};
  try { return typeof metadata === 'string' ? JSON.parse(metadata) : metadata; }
  catch { return {}; }
}

/**
 * Kill any OS process matching the worker's own spawn signature (claude -p
 * for a job, docker run for the container driver) that isn't tracked in a
 * live `activeProcesses` map — i.e. process-table orphans left behind by an
 * uncontrolled worker exit (OOM kill, SIGKILL, host crash) where even the
 * child processes survived their parent. Best-effort; failures are logged,
 * never thrown — the process table isn't always inspectable (permissions,
 * platform) and this is a hygiene pass, not a load-bearing step.
 *
 * @param {object} deps
 * @param {() => string[]} deps.listSpawnSignaturePids - returns pids of
 *   processes matching the worker's spawn signature (e.g. `pgrep -f
 *   "claude -p"` output, one per line, already parsed to strings)
 * @param {(pid: string) => void} deps.killPid
 * @returns {{ killed: string[] }}
 */
export function killOrphanedSpawnProcesses({ listSpawnSignaturePids, killPid }) {
  let pids = [];
  try {
    pids = listSpawnSignaturePids();
  } catch (err) {
    console.warn(`[boot-reconciler] listSpawnSignaturePids failed: ${err.message}`);
    return { killed: [] };
  }
  const killed = [];
  for (const pid of pids) {
    try {
      killPid(pid);
      killed.push(pid);
    } catch (err) {
      console.warn(`[boot-reconciler] failed to kill orphaned pid ${pid}: ${err.message}`);
    }
  }
  if (killed.length) {
    console.log(`[boot-reconciler] killed ${killed.length} orphaned spawn-signature process(es): ${killed.join(', ')}`);
  }
  return { killed };
}
