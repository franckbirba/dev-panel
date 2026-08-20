// src/worker/failure-classifier.js
//
// Engine contract §4.2 — the taxonomy that replaces the retry-stacking bug.
// Every failure the worker observes belongs to exactly ONE class, and each
// class has exactly ONE recovery mechanism:
//
//   infra_failure   — spawn impossible, clone/fetch/auth KO, worktree KO,
//                      Plane API down. Detected BEFORE the agent produced
//                      any work. Mechanism: BullMQ retry, backoff expo,
//                      bounded at 2 retries. Never consumes a review
//                      revision; never re-runs the agent once work started.
//   agent_failure    — invalid envelope (parseResult), stall/timeout (§5),
//                      budget exceeded (§6), driver crash. Detected
//                      DURING/AFTER the agent's work. Zero blind retry.
//                      The ONE exception: an invalid envelope gets exactly
//                      one retry-with-feedback (the agent is handed back
//                      its own validation error + the expected schema).
//   quality_failure  — reviewer/qa legitimately return status=failed on a
//                      valid envelope. Mechanism: the YAML revision loop
//                      (`next: builder`, bounded by `max_revisions`).
//   ambiguity        — the agent itself reports status=blocked. Mechanism:
//                      workflow `replan`, then `awaiting_input`.
//
// This module is intentionally pure — no I/O, no BullMQ, no Postgres. It
// takes a small descriptor of "what happened" and returns a classification
// plus the bounded recovery decision. Callers (spawnAgent / the worker job
// processor) own the actual retry/kill/notify side effects; this module only
// decides WHAT class an event belongs to and HOW MANY retries remain.

/**
 * @typedef {'infra_failure'|'agent_failure'|'quality_failure'|'ambiguity'} FailureClass
 */

export const FAILURE_CLASSES = Object.freeze({
  INFRA: 'infra_failure',
  AGENT: 'agent_failure',
  QUALITY: 'quality_failure',
  AMBIGUITY: 'ambiguity',
});

// Bounds from the contract (§4.2). Not overridable via env — these are the
// mechanism's shape, not a per-role tuning knob (unlike timeouts/budgets).
export const MAX_INFRA_RETRIES = 2;
export const MAX_ENVELOPE_FEEDBACK_RETRIES = 1;

// Reasons that mark a failure as having happened BEFORE the agent produced
// any work — i.e. infra, not agent. Used by classifyThrown() to inspect an
// Error thrown out of the spawn/worktree-prep path.
const INFRA_REASON_PATTERNS = [
  /^worktree/i,               // worktree prepare/clone failure
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT/,  // network/DNS
  /clone|fetch|checkout/i,
  /spawn.*ENOENT/i,           // claude/pi/goose binary missing
  /plane.*(down|unreachable|5\d\d)/i,
  /auth.*(failed|denied|401|403)/i,
];

/**
 * Classify a failure that happened while preparing to run an agent (worktree
 * setup, spawn ENOENT, network to Plane/GitHub) — i.e. before any agent
 * turn executed. Always infra_failure; the taxonomy has no other class for
 * "the agent never got to try".
 *
 * @param {Error|string} err
 * @returns {{ failure_class: 'infra_failure', reason: string }}
 */
export function classifyPreSpawnError(err) {
  const message = err instanceof Error ? err.message : String(err || 'unknown error');
  return { failure_class: FAILURE_CLASSES.INFRA, reason: message.slice(0, 300) };
}

/**
 * Best-effort classification of an arbitrary thrown error into infra vs
 * agent. Used when a driver rejects its spawn promise and we don't already
 * know from context whether the agent got to run. Defaults to agent_failure
 * (the safer default — infra retries are for errors we're SURE happened
 * before work started; misclassifying an agent crash as infra would grant
 * a blind retry the contract forbids).
 *
 * @param {Error|string} err
 * @param {{ workStarted?: boolean }} [opts]
 * @returns {{ failure_class: FailureClass, reason: string }}
 */
export function classifyThrown(err, { workStarted = false } = {}) {
  const message = err instanceof Error ? err.message : String(err || 'unknown error');
  if (!workStarted && INFRA_REASON_PATTERNS.some((re) => re.test(message))) {
    return { failure_class: FAILURE_CLASSES.INFRA, reason: message.slice(0, 300) };
  }
  return { failure_class: FAILURE_CLASSES.AGENT, reason: message.slice(0, 300) };
}

/**
 * Classify a parseResult() failure (invalid/missing closing JSON envelope).
 * Always agent_failure — the agent ran and produced *something*, it just
 * didn't conform to the output contract.
 *
 * @param {string} parseError
 * @returns {{ failure_class: 'agent_failure', reason: 'invalid_envelope', detail: string }}
 */
export function classifyEnvelopeFailure(parseError) {
  return {
    failure_class: FAILURE_CLASSES.AGENT,
    reason: 'invalid_envelope',
    detail: String(parseError || '').slice(0, 500),
  };
}

/**
 * Classify a stall (§5 — no driver event for STALL_TIMEOUT_MS) or a
 * wall-clock timeout kill. Always agent_failure.
 *
 * @param {'stall'|'wall_clock'} kind
 * @returns {{ failure_class: 'agent_failure', reason: 'stall'|'timeout' }}
 */
export function classifyTimeout(kind) {
  return {
    failure_class: FAILURE_CLASSES.AGENT,
    reason: kind === 'stall' ? 'stall' : 'timeout',
  };
}

/**
 * Classify a budget-exceeded kill (§6). Always agent_failure.
 *
 * @returns {{ failure_class: 'agent_failure', reason: 'budget' }}
 */
export function classifyBudgetExceeded() {
  return { failure_class: FAILURE_CLASSES.AGENT, reason: 'budget' };
}

/**
 * Classify a valid envelope's own status. `done` is not a failure (returns
 * null). `blocked` is ambiguity. `failed` is quality_failure (the agent
 * itself, or the reviewer/qa it ran under, judged the work insufficient —
 * NOT a crash, NOT malformed output).
 *
 * @param {'done'|'blocked'|'failed'} status
 * @returns {null|{ failure_class: FailureClass }}
 */
export function classifyEnvelopeStatus(status) {
  if (status === 'done') return null;
  if (status === 'blocked') return { failure_class: FAILURE_CLASSES.AMBIGUITY };
  if (status === 'failed') return { failure_class: FAILURE_CLASSES.QUALITY };
  // Unknown status should never reach here (prompt-builder validates the
  // enum before this is called) — treat conservatively as agent_failure so
  // nothing loops silently.
  return { failure_class: FAILURE_CLASSES.AGENT, reason: `unknown_status:${status}` };
}

/**
 * Decide whether an infra_failure should retry. Pure function over the
 * attempt counter BullMQ exposes (job.attemptsMade) — the engine, not the
 * queue, owns this decision now (contract §4.2: BullMQ passes to
 * `attempts: 1`; retries are decided here).
 *
 * @param {number} attemptsMade - 0-indexed count of attempts already made
 *   (BullMQ's job.attemptsMade before this attempt is counted)
 * @returns {{ shouldRetry: boolean, retriesRemaining: number }}
 */
export function decideInfraRetry(attemptsMade) {
  const retriesRemaining = Math.max(0, MAX_INFRA_RETRIES - attemptsMade);
  return { shouldRetry: attemptsMade < MAX_INFRA_RETRIES, retriesRemaining };
}

/**
 * Decide whether an invalid-envelope agent_failure should get its one
 * retry-with-feedback. `envelopeRetriesUsed` is a counter the caller must
 * thread through job data (e.g. `jobData.envelope_retry_count`) since BullMQ
 * attempts are now capped at 1 and can't carry this state across the retry
 * for us.
 *
 * @param {number} envelopeRetriesUsed
 * @returns {{ shouldRetry: boolean }}
 */
export function decideEnvelopeRetry(envelopeRetriesUsed = 0) {
  return { shouldRetry: envelopeRetriesUsed < MAX_ENVELOPE_FEEDBACK_RETRIES };
}

/**
 * Build the feedback block handed back to the agent on the one allowed
 * envelope retry — the exact validation error plus the expected schema, so
 * a floor-tier model can self-correct on the first try (ADR-004 v2).
 *
 * @param {string} parseError
 * @returns {string}
 */
export function buildEnvelopeFeedback(parseError) {
  return [
    '## Previous attempt — invalid output envelope',
    '',
    'Your last response did not end with a valid JSON envelope. This is your',
    'ONE retry — fix the format below exactly, or this job fails permanently.',
    '',
    `**Validation error:** ${parseError}`,
    '',
    '**Required schema (last line of your response, nothing after it):**',
    '```json',
    '{"status":"done|blocked|failed","summary":"...","artifacts":{"files_created":[],"files_modified":[],"commits":[],"branch":null,"tests_passed":false,"pr_url":null},"handoff":{"next_agent":null,"reason":""},"memory_writes_count":0,"blockers":[],"issues_found":[]}',
    '```',
  ].join('\n');
}
