// src/worker/token-usage.js
//
// Engine contract §6 — token budget tracking. "Tokens per job, counted on
// the stream of the driver" — the ADR-004 v2 driver contract requires every
// driver to expose usage; a driver that can't is ineligible for the
// critical path. This module extracts usage from the Claude
// `stream-json` event shape and accumulates it across a run so
// src/worker/index.js can compare against budgetTokensFor(role) and kill
// on overage (agent_failure, reason=budget).
//
// Pure functions only — no timers, no process control (that's
// process-timeout-controller.js's job). index.js wires extractUsage() into
// the stream-parser callback and calls accumulate() per event.

/**
 * Extract token usage from a single stream-json event, if present.
 * Claude Code's stream-json carries `usage` on `assistant` message events
 * (per-turn, from the Anthropic Messages API) and a cumulative usage on the
 * final `result` event. Both shapes are handled; callers should prefer
 * summing per-turn `assistant` usage since `result` usage isn't guaranteed
 * present on every harness version.
 *
 * @param {object} event - a parsed stream-json line
 * @returns {{ input_tokens: number, output_tokens: number, cache_creation_input_tokens: number, cache_read_input_tokens: number } | null}
 */
export function extractUsage(event) {
  const usage = event?.message?.usage || event?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    input_tokens: num(usage.input_tokens),
    output_tokens: num(usage.output_tokens),
    cache_creation_input_tokens: num(usage.cache_creation_input_tokens),
    cache_read_input_tokens: num(usage.cache_read_input_tokens),
  };
}

/**
 * Total "billable-ish" token count for one usage snapshot. We count
 * input + output + cache_creation (fresh work) but NOT cache_read (re-reads
 * of already-cached context are cheap and shouldn't count against the
 * budget the same way — otherwise a long-running agent with a big system
 * prompt would blow its budget on cache hits alone).
 *
 * @param {ReturnType<typeof extractUsage>} usage
 * @returns {number}
 */
export function usageTotal(usage) {
  if (!usage) return 0;
  return usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens;
}

/**
 * Create an accumulator that tracks running token usage across a stream of
 * events for one job. Each `assistant` event's usage in Claude's
 * stream-json is CUMULATIVE for the turn it's attached to but turns don't
 * stack additively in a simple way across multi-turn tool use — the safest
 * general approach (and what Anthropic's own examples do) is to track the
 * MAX cumulative usage seen, since Claude Code's stream-json reports
 * running totals per assistant message as the conversation grows within a
 * single `-p` invocation.
 *
 * @returns {{ record(event: object): void, total(): number, snapshot(): object }}
 */
export function createUsageAccumulator() {
  let maxTotal = 0;
  let last = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  return {
    record(event) {
      const usage = extractUsage(event);
      if (!usage) return;
      const total = usageTotal(usage);
      if (total >= maxTotal) {
        maxTotal = total;
        last = usage;
      }
    },
    total() {
      return maxTotal;
    },
    snapshot() {
      return { ...last, total: maxTotal };
    },
  };
}

/**
 * Decide whether a running total has exceeded the role's budget.
 *
 * @param {number} totalTokens
 * @param {number} budgetTokens
 * @returns {boolean}
 */
export function isBudgetExceeded(totalTokens, budgetTokens) {
  return totalTokens > budgetTokens;
}
