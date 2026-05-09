// src/worker/select-pi-model.js
//
// Phase 2 of the harness migration (plan
// `/Users/franckbirba/.claude/plans/ok-anyway-we-need-enumerated-lighthouse.md`):
// Pi (`@earendil-works/pi-coding-agent`) is a Claude-Code-equivalent CLI that
// can drive Anthropic, OpenAI, DeepInfra (Qwen3), Ollama and 12+ other
// providers from the same harness. We adopt it for cheap-tier roles to get
// real model independence — Phase 1 (Haiku-on-Claude-Code) only swapped the
// model inside Anthropic's walled garden.
//
// This helper resolves an agent role to a { provider, model } pair that pi
// understands. Default routes cheap-tier to DeepInfra/Qwen3 (the strategic
// goal), hard-tier to Anthropic Opus (Pi can drive Anthropic too — once we
// build confidence we can drop Claude Code entirely).

const CHEAP_TIER_ROLES = new Set([
  'builder', 'designer', 'pm', 'merge-coordinator'
]);
const HARD_TIER_ROLES = new Set([
  'reviewer', 'qa', 'architect', 'deploy'
]);

const CHEAP_DEFAULT = {
  provider: 'deepinfra',
  model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct'
};
const HARD_DEFAULT = {
  provider: 'anthropic',
  model: 'claude-opus-4-7'
};

// Parse "<provider>/<model>" or just "<model>" (legacy/short form falls back
// to deepinfra). Empty / non-string returns null.
function parsePiModelString(s) {
  if (!s || typeof s !== 'string') return null;
  const idx = s.indexOf('/');
  if (idx < 0) return { provider: 'deepinfra', model: s };
  // Some model ids like "Qwen/Qwen3-..." legitimately contain slashes — first
  // slash separates provider from model id; everything after is the model.
  // Only treat the prefix as a provider if it's one of the known slug shapes
  // (lowercase-letters-and-dash). Otherwise assume the whole string is a
  // model id under deepinfra.
  const head = s.slice(0, idx);
  const rest = s.slice(idx + 1);
  if (/^[a-z][a-z0-9-]*$/.test(head)) return { provider: head, model: rest };
  return { provider: 'deepinfra', model: s };
}

// Precedence (high → low):
//   1. FORCE_PI_MODEL=<provider>/<model>      — global kill switch
//   2. DRIVER_<AGENT>_PI_MODEL=<provider>/<model>  — per-role pin
//   3. cheap/hard tier table                  — defaults
//   4. null                                    — caller must abort or pick fallback
export function selectPiModel(agentRole, env = process.env) {
  const force = parsePiModelString(env.FORCE_PI_MODEL);
  if (force) return force;

  const envKey = `DRIVER_${String(agentRole || '').toUpperCase().replace(/-/g, '_')}_PI_MODEL`;
  const pinned = parsePiModelString(env[envKey]);
  if (pinned) return pinned;

  if (CHEAP_TIER_ROLES.has(agentRole)) return CHEAP_DEFAULT;
  if (HARD_TIER_ROLES.has(agentRole)) return HARD_DEFAULT;
  return null;
}
