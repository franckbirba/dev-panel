// src/worker/budget-guard.js
//
// Daily token budget guard for the worker fleet.
// Tracks tokens consumed per day and suspends backlog pulling when limits are reached.

const DEFAULT_DAILY_TOKEN_BUDGET = 5000000; // 5M tokens

/**
 * Get the daily token budget from environment variables.
 * @param {object} env - Environment variables object
 * @returns {number|null} Token budget (null if unlimited)
 */
export function getDailyTokenBudget(env = process.env) {
  const raw = env.DAILY_TOKEN_BUDGET;
  if (raw === undefined || raw === '') return DEFAULT_DAILY_TOKEN_BUDGET;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DAILY_TOKEN_BUDGET;
  return n === 0 ? null : n; // 0 = explicitly disabled
}

/**
 * Calculate tokens consumed today from the agent_job_log table.
 * @param {import('pg').Pool} pool - PostgreSQL connection pool
 * @returns {Promise<number>} Tokens consumed today
 */
export async function getTokensConsumedToday(pool) {
  try {
    // Reset at midnight Europe/Paris time
    const { rows } = await pool.query(`
      SELECT COALESCE(SUM(input_tokens + output_tokens + cache_creation_input_tokens), 0) AS total
      FROM agent_job_log
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Paris')
    `);
    return Number(rows[0]?.total ?? 0);
  } catch (err) {
    console.error('[BudgetGuard] Failed to query token consumption:', err.message);
    return 0; // Fail open - don't block dispatches if we can't track consumption
  }
}

/**
 * Check if the daily token budget has been exceeded.
 * @param {object} params
 * @param {number} params.tokensConsumed - Tokens consumed today
 * @param {number|null} params.budget - Daily token budget (null if unlimited)
 * @returns {{exceeded: boolean, percentage: number}}
 */
export function isBudgetExceeded({ tokensConsumed, budget }) {
  if (budget === null) return { exceeded: false, percentage: 0 };
  
  const percentage = budget > 0 ? (tokensConsumed / budget) * 100 : 0;
  return {
    exceeded: tokensConsumed >= budget,
    percentage: Math.min(percentage, 100)
  };
}

/**
 * Check if we should warn about approaching budget limit (80% threshold).
 * @param {object} params
 * @param {number} params.tokensConsumed - Tokens consumed today
 * @param {number|null} params.budget - Daily token budget (null if unlimited)
 * @returns {boolean}
 */
export function shouldWarnBudgetApproaching({ tokensConsumed, budget }) {
  if (budget === null) return false;
  return tokensConsumed >= budget * 0.8 && tokensConsumed < budget;
}

/**
 * Log budget status information.
 * @param {object} params
 * @param {number} params.tokensConsumed - Tokens consumed today
 * @param {number|null} params.budget - Daily token budget (null if unlimited)
 * @param {boolean} params.exceeded - Whether budget is exceeded
 * @param {number} params.percentage - Percentage of budget consumed
 */
export function logBudgetStatus({ tokensConsumed, budget, exceeded, percentage }) {
  if (budget === null) {
    console.log(`[BudgetGuard] Budget tracking disabled (unlimited tokens)`);
    return;
  }

  const formattedConsumed = tokensConsumed.toLocaleString();
  const formattedBudget = budget.toLocaleString();
  
  if (exceeded) {
    console.log(
      `[BudgetGuard] Daily token budget exceeded: ${formattedConsumed} / ${formattedBudget} tokens ` +
      `(${percentage.toFixed(1)}%) - backlog pulling suspended`
    );
  } else if (percentage >= 80) {
    console.log(
      `[BudgetGuard] Warning: Daily token budget approaching limit: ${formattedConsumed} / ${formattedBudget} tokens ` +
      `(${percentage.toFixed(1)}%)`
    );
  } else {
    console.log(
      `[BudgetGuard] Daily token consumption: ${formattedConsumed} / ${formattedBudget} tokens ` +
      `(${percentage.toFixed(1)}%)`
    );
  }
}