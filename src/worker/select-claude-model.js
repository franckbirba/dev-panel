// src/worker/select-claude-model.js
//
// Phase 1 of the harness-vs-model canary (plan
// `/Users/franckbirba/.claude/plans/ok-anyway-we-need-enumerated-lighthouse.md`):
// disambiguate whether the studio's quality came from Opus the model or from
// Claude Code the harness, by routing cheap-tier roles to Haiku-4.5 on the
// SAME harness. If Haiku holds, the harness is what carries the studio — and
// Phase 2 (claw, the model-agnostic harness) ships with empirical confidence.

const CHEAP_TIER_ROLES = new Set([
  'builder', 'designer', 'pm', 'merge-coordinator'
]);
const HARD_TIER_ROLES = new Set([
  'reviewer', 'qa', 'architect', 'deploy'
]);
const MODEL_ALIASES = {
  opus:   'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001'
};

// Precedence (high → low):
//   1. FORCE_MODEL=<alias|model-id>      — global kill switch
//   2. DRIVER_<AGENT>_MODEL=<alias|id>   — per-role pin
//   3. cheap/hard tier table             — defaults for known roles
//   4. null                              — caller skips --model and falls
//                                          back to ambient ~/.claude.json
//                                          (preserves pre-Phase-1 behavior)
export function selectClaudeModel(agentRole, env = process.env) {
  const force = env.FORCE_MODEL;
  if (force) return MODEL_ALIASES[force] || force;

  const envKey = `DRIVER_${String(agentRole || '').toUpperCase().replace(/-/g, '_')}_MODEL`;
  const pinned = env[envKey];
  if (pinned) return MODEL_ALIASES[pinned] || pinned;

  if (CHEAP_TIER_ROLES.has(agentRole)) return MODEL_ALIASES.haiku;
  if (HARD_TIER_ROLES.has(agentRole))  return MODEL_ALIASES.opus;
  return null;
}
