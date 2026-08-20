// src/worker/timeout-policy.js
//
// Engine contract §5 — stall detection + wall-clock timeouts, and §6 —
// per-role token budgets. Pure config/decision functions: no child_process,
// no timers, no I/O. src/worker/index.js wires these into the actual
// spawn/kill lifecycle (ProcessTimeoutController).
//
// The contract is explicit that the timeout is a FILET (safety net), not
// the primary mechanism — task sizing is. So these numbers are generous
// per-role ceilings, and stall detection (5 min with zero driver events) is
// the signal that actually catches the historical "1h silent run" failure
// mode fast.

// §5 — wall-clock ceilings per role, in ms. Defaults from the contract.
const DEFAULT_AGENT_TIMEOUT_MS = {
  builder: 20 * 60 * 1000,
  qa: 15 * 60 * 1000,
  reviewer: 15 * 60 * 1000,
  architect: 15 * 60 * 1000,
  'merge-coordinator': 15 * 60 * 1000,
  pm: 10 * 60 * 1000,
};

const FALLBACK_AGENT_TIMEOUT_MS = 15 * 60 * 1000; // unknown role → reviewer-tier

// §5 — stall detection: no driver event (tool call, text) since this many ms.
const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;

// §6 — token budgets per role. Defaults from Shelly's SOUL, now in code.
const DEFAULT_BUDGET_TOKENS = {
  builder: 200_000,
  qa: 150_000,
  reviewer: 100_000,
};
const FALLBACK_BUDGET_TOKENS = 80_000; // "autres"

function envRoleKey(role) {
  return String(role || '').toUpperCase().replace(/-/g, '_');
}

/**
 * Wall-clock timeout for a role, in ms. Override via
 * `AGENT_TIMEOUT_<ROLE>_MS` (role dashes become underscores, e.g.
 * `AGENT_TIMEOUT_MERGE_COORDINATOR_MS`).
 *
 * @param {string} role
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} timeout in ms
 */
export function agentTimeoutMs(role, env = process.env) {
  const override = env[`AGENT_TIMEOUT_${envRoleKey(role)}_MS`];
  if (override) {
    const n = parseInt(override, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_AGENT_TIMEOUT_MS[role] ?? FALLBACK_AGENT_TIMEOUT_MS;
}

/**
 * Stall detection window, in ms. Override via `STALL_TIMEOUT_MS`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function stallTimeoutMs(env = process.env) {
  const override = env.STALL_TIMEOUT_MS;
  if (override) {
    const n = parseInt(override, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_STALL_TIMEOUT_MS;
}

/**
 * Token budget for a role. Override via `BUDGET_TOKENS_<ROLE>`.
 *
 * @param {string} role
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function budgetTokensFor(role, env = process.env) {
  const override = env[`BUDGET_TOKENS_${envRoleKey(role)}`];
  if (override) {
    const n = parseInt(override, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_BUDGET_TOKENS[role] ?? FALLBACK_BUDGET_TOKENS;
}

/**
 * Grace period between SIGTERM and SIGKILL when killing a stalled/timed-out
 * process group (§5: "SIGTERM → 30s de grâce → SIGKILL").
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function killGraceMs(env = process.env) {
  const override = env.AGENT_KILL_GRACE_MS;
  if (override) {
    const n = parseInt(override, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 30 * 1000;
}

/**
 * BullMQ lockDuration for the agents queue. Invariant (§5): lockDuration
 * must exceed max(timeout per role) + 5 min, or the lock can expire before
 * the worker's own kill fires — opening the door to double-dispatch on the
 * same job. Computed from the live role table (+ env overrides) rather than
 * hardcoded, so a future role/timeout bump can't silently violate the
 * invariant again.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function computeLockDurationMs(env = process.env) {
  const roles = Object.keys(DEFAULT_AGENT_TIMEOUT_MS);
  const maxTimeout = Math.max(
    FALLBACK_AGENT_TIMEOUT_MS,
    ...roles.map((r) => agentTimeoutMs(r, env))
  );
  return maxTimeout + 5 * 60 * 1000;
}

/**
 * Verify the lockDuration invariant holds for a given lockDuration value.
 * Used both defensively at startup (throw/log loud if violated) and in
 * tests.
 *
 * @param {number} lockDurationMs
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ ok: boolean, minRequiredMs: number }}
 */
export function checkLockDurationInvariant(lockDurationMs, env = process.env) {
  const minRequiredMs = computeLockDurationMs(env);
  return { ok: lockDurationMs > minRequiredMs, minRequiredMs };
}

export const DEFAULTS = Object.freeze({
  AGENT_TIMEOUT_MS: Object.freeze({ ...DEFAULT_AGENT_TIMEOUT_MS }),
  FALLBACK_AGENT_TIMEOUT_MS,
  STALL_TIMEOUT_MS: DEFAULT_STALL_TIMEOUT_MS,
  BUDGET_TOKENS: Object.freeze({ ...DEFAULT_BUDGET_TOKENS }),
  FALLBACK_BUDGET_TOKENS,
});
