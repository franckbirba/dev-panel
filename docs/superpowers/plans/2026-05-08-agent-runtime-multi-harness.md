# Agent Runtime — Multi-Harness (Claude Code + goose × Qwen3-Coder)

**Date:** 2026-05-08
**Driver:** Franck (urgent — Anthropic rate limits hit weekly across 3 projects × 4 collaborators; Max 20x ≈ 220k tokens / 5h, current load ≈ 1M tokens / 5h)
**Goal:** Stop being a single-vendor shop. Route routine work to OSS via a cheap provider; keep Claude for hard work. Same SOUL.md, same MCP tools, same worktree contract, same `notifyJob()`.

**Locked decisions (do not relitigate):**
- **Cheap-tier model:** `Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo` (FP4) — only OSS model within 3-4 pts of Sonnet-4 on multi-turn MCP tool-call fidelity. FP4 over FP8 (non-Turbo): same 480B/35B-active arch, ~70% cheaper, $0.10/M cached input. FP4 quant regression on long-loop arg fidelity not measured publicly; failure mode is context-drift, hits FP8 identically. Revisit only on measurable regression.
- **Cheap-tier provider:** DeepInfra (OpenAI-compat endpoint, $0.30/M in, $1.00/M out, $0.10/M cached, projected ~$50/mo at 5M tokens/day).
- **Cheap-tier harness:** goose (Block) — MCP-native, headless via `goose run`, swappable backend. Pi rejected for Phase A (no native MCP, would force MCP→Skills rewrite).
- **Hard-tier:** Claude Code unchanged (Opus/Sonnet via existing Max subscriptions).
- **No self-hosted GPU.** Break-even sits at ~15M tokens/day; we're at ~5M. Revisit at 3× growth or on-prem client requirement.

---

## Phase A — Just get Claude Code + goose+Qwen3 running (TODAY → end of week)

Minimum viable: a second harness exists, a routine work item ran end-to-end on it, kill switch lets us flip back to Claude in one env var. No abstraction layer yet.

### Track A1 — Kill the broken merge-coordinator webhook auto-dispatch (≤ 30 min)

Blocking nothing else. The current webhook fires merge-coordinator on every PR push, the workflow blocks 100% of the time, Franck merges manually anyway. Strip auto-dispatch for human PRs.

**File:** `src/server/webhooks-github.js`

1. After the `closed`-event branch (line 125), gate dispatch on:
   - PR has label `agent-merge` (read from `pr.labels[].name`).
   - PR author login ∈ `dev_bots` table (helper: `getDevBotLoginSet()` queries the same table telegram-multi pairing uses).
2. Either fail → `return res.status(204).end()` + log: `[webhook] merge-coordinator skipped for ${repo}#${prNumber}: not an agent PR`.
3. Keep the `closed`/release-broadcast branch untouched.

**Test:** `tests/server/webhooks-github.test.js` — two cases:
- Human PR (no label, human author) → dispatch NOT called.
- Agent PR (label + dev_bot author) → dispatch called.

**Rollback:** revert one commit.

### Track A2 — Narrow merge-coordinator to a single-shot predicate (≤ 1 h)

**File:** `src/worker/workflows/merge-coordinator.yaml` — replace the whole file:

```yaml
name: merge-coordinator
description: Auto-squash-merge for agent PRs only. Single-shot. No retreats. Notify Shelly on any non-mergeable signal.
max_revisions: 1
on_exhaustion: block

steps:
  - agent: merge-coordinator
    on:
      done:    { terminal: true }
      blocked: { terminal: true }
      failed:  { terminal: true }
```

**SOUL** (`.agents/merge-coordinator/SOUL.md`) — pre-flight predicate (all required, in order):
1. PR base = main
2. PR `mergeable_state = "clean"` (no conflicts)
3. All required checks = success
4. PR author ∈ dev_bots

If ALL pass → `gh pr merge --squash --auto`. If ANY fail → `notifyJob` with the failing predicate, status=blocked. Do NOT attempt to fix. No builder retreat.

Measure 2 weeks via `workflow_instances WHERE workflow_name='merge-coordinator' AND status='success'`. If <5/week, kill the workflow entirely and let Shelly dispatch merges on demand.

### Track A3 — DeepInfra account + goose installed on agents host (≤ 1 h)

1. Open DeepInfra account, generate API key, store on services-side `.env.production` as `DEEPINFRA_API_KEY=...`.
2. Set `OPENROUTER_MAX_DAILY_USD=10` style soft alert in monitoring (use existing alert pipe — adapt to DeepInfra spend endpoint).
3. SSH `hetzner-vps` (agents host), as `deploy`:
   ```bash
   curl -fsSL https://github.com/block/goose/releases/latest/download/goose-installer.sh | bash
   goose --version  # confirm single binary in ~/.local/bin
   ```
4. Smoke `goose` against DeepInfra in Franck's home dir (NOT inside any project worktree):
   ```bash
   GOOSE_PROVIDER=openai \
   GOOSE_BASE_URL=https://api.deepinfra.com/v1/openai \
   OPENAI_API_KEY=$DEEPINFRA_API_KEY \
   GOOSE_MODEL=Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo \
   goose run -t "list 3 files in this dir using a tool, no prose"
   ```
   Pass condition: emits a tool call, prints the 3 files, exits 0. If goose's MCP loop fails to fire even one tool cleanly here, **stop** — Phase A is blocked, not the model's fault, harness wiring is wrong.

### Track A4 — Wire the goose driver into the worker (≤ 3 h)

**Don't extract the abstraction yet** (that's Phase B). Add a minimal branch in the existing `spawnAgent` keyed off env.

**File:** `src/worker/index.js` (the `spawnAgent` function, line 145–230)

Add at the top of the function:
```js
function spawnAgent(jobId, prompt, agentRole, cwd) {
  const useGoose = process.env[`DRIVER_${agentRole.toUpperCase().replace(/-/g, '_')}`] === 'goose'
                || (process.env.DRIVER_DEFAULT === 'goose' && process.env.FORCE_TIER !== 'opus');
  if (useGoose) return spawnGoose(jobId, prompt, agentRole, cwd);
  // ...existing claude spawn unchanged
}
```

Add `spawnGoose` next to it:
- Spawns `goose run --no-session -t <prompt-from-stdin-or-file>` with cwd, env carrying `GOOSE_PROVIDER`/`GOOSE_BASE_URL`/`OPENAI_API_KEY`/`GOOSE_MODEL`.
- MCP servers: render `mcp_config_path` (existing `~/.mcp-worker.json`) into goose extension config in a per-job tmpdir, point goose at it via `--config <path>` if available, else `GOOSE_CONFIG_PATH` env. Validate the flag exists during Track A3 smoke; if neither works, write `~/.config/goose/config.yaml` once and document it lives there permanently.
- Streams: parse goose's stdout into the same shape `appendEvent` expects (minimum: `tool_use`, `tool_result`, `assistant_text`, final `result`). Write a tiny mapper at `src/worker/goose-events.js`.
- Stderr: same `errLog` path as Claude.
- Exit code: same contract — 0 = success, returns final text for `parseResult`; non-zero rejects.
- `activeProcesses.set(jobId, { process: proc, startedAt })` so `cancel_job` works identically.

**No SOUL changes.** SOUL.md is loaded by the prompt-builder into the prompt body. Both harnesses see the same prompt — only the loop driving it differs. If goose produces sloppier `[thread:*]` tagging, fix in SOUL after first 5 jobs, not now.

### Track A5 — Default OFF, flip ON for ONE role (≤ 30 min)

1. Ship A1+A2+A3+A4 to prod with `DRIVER_DEFAULT=claude` (or unset). Nothing changes for users yet.
2. Pick **builder** as the canary. On services-side `.env.production`:
   ```
   DRIVER_BUILDER=goose
   GOOSE_PROVIDER=openai
   GOOSE_BASE_URL=https://api.deepinfra.com/v1/openai
   OPENAI_API_KEY=${DEEPINFRA_API_KEY}
   GOOSE_MODEL=Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo
   ```
3. Watch one full nightly batch on hetzner-vps:
   ```bash
   tail -f /home/deploy/logs/worker.log
   docker exec devpanel-api node -e 'require("./src/server/jobs-events.js").tail(50)' # adapt
   ```
4. Pass condition for "Phase A done": **3 consecutive builder jobs** finish with status=success, commits land in the right worktree, PRs open against the right repo, `notifyJob()` fires with the right `[thread:*]` tag.
5. **Kill switch:** `DRIVER_BUILDER=claude` flips back instantly. Document this in `CLAUDE.md` under a new "Cheap-tier kill switch" section.

### Phase A done means
- Webhook no longer auto-fires for human PRs.
- `merge-coordinator` is single-shot predicate-only.
- goose binary on agents host, DeepInfra wired.
- `spawnGoose` exists in worker, gated by `DRIVER_BUILDER=goose`.
- 3 consecutive builder jobs ran on Qwen3-Coder via goose, green.
- Kill switch tested.

Everything else is Phase B.

---

## Phase B — Full genericity (next 2–4 weeks, AFTER Phase A is green for 7 days)

The abstraction the architect described in the previous round. Don't start until Phase A has run 7 days without rollback.

### B1 — Extract `AgentSpec` + per-harness driver layer

**Layer 1 — `AgentSpec` (pure data):**
```ts
type AgentSpec = {
  agent: 'builder' | 'reviewer' | 'qa' | 'designer' | 'pm' | 'merge-coordinator' | 'deploy';
  prompt: string;
  cwd: string;
  mcp_config_path: string;
  job_id: string;
  agent_role: string;
  model_tier: 'opus' | 'sonnet' | 'cheap';
  timeout_ms: number;
};
```
Carries paths, not content. Serializable.

**Layer 2 — drivers, all in `src/worker/drivers/`:**
- `claude.js` — extracted from current `spawnAgent`, zero behavior change.
- `goose.js` — extracted from `spawnGoose` shipped in Phase A.
- `index.js` — `selectDriver(spec) -> Driver` based on `model_tier` + per-workflow env override.

Driver contract:
```ts
type DriverResult = { exit_code: number; final_text: string | null; events_count: number; log_path: string };
type Driver = (spec: AgentSpec, hooks: {
  onEvent: (event: object) => void;
  onStderr: (chunk: Buffer) => void;
  registerProcess: (proc: ChildProcess) => void;
}) => Promise<DriverResult>;
```

After this, `spawnAgent` in `index.js` is a 3-line shim: `buildAgentSpec → selectDriver → runDriver`.

**Acceptance:** `claude.js` and `goose.js` share <30% of code. If they share >80%, the abstraction is over-built — collapse it.

### B2 — Routing predicate (honest cut only)

`src/worker/drivers/routing.js`:
```js
export function selectModelTier(jobData) {
  const HARD = new Set(['deploy', 'qa', 'architect', 'reviewer']);
  if (HARD.has(jobData.agent)) return 'opus';
  if ((jobData.workflow_revision || 1) > 1) return 'opus';      // anything that retreated once
  if (jobData.context?.previous_attempts > 0) return 'opus';
  return 'cheap';                                               // builder, designer, pm, merge-coordinator first attempt
}
```

Drop `label`, `file count`, `has_screenshots` — all wishful (architect verdict).

Override knobs (env, not code):
- `FORCE_TIER=opus` — kill switch, all jobs to Claude.
- `DRIVER_<AGENT>=goose|claude` — pin a workflow.

### B3 — Roll the rest of the cheap-tier roles

In 24h increments, in this order:
1. `designer` (Phase B day 1)
2. `pm` (day 2)
3. `merge-coordinator` (day 3, only if Phase A's narrowed workflow is firing successfully on the 1–4 PRs/week shape)

Watch `workflow_instances` failure rate per role. >10% failure on a role within 24h → revert that role to claude, file a SOUL/prompt issue.

### B4 — Cost monitoring

Add `src/server/deepinfra-spend.js` polling DeepInfra's billing endpoint hourly, surface daily spend on the dashboard. Hard cutoff: if daily spend >$5, page Shelly via `notifyJob()`. Soft alert at $3.

### B5 — Retire the temporary shim

Delete the inline `useGoose` branch in `spawnAgent` (Phase A leftover). `spawnAgent` becomes the 3-line shim from B1.

### Phase B done means
- AgentSpec + driver layer exists, claude.js and goose.js are siblings.
- Routing predicate decides tier before dispatch.
- 4 roles run on cheap tier in production: builder, designer, pm, merge-coordinator.
- Daily DeepInfra spend visible + alert wired.
- Phase A's inline branch removed.

---

## Hard constraints (apply to BOTH phases)

- **Do not** change `notifyJob()`, `parseResult()`, `appendEvent()` signatures. Drivers translate into existing shapes.
- **Do not** change MCP server config templates. Both harnesses read the same `mcp_config_path`; goose driver translates on the fly.
- **Do not** route Shelly's tmux session to goose. Shelly stays Claude Code, period — orchestrator, not coder.
- **Do not** ship Phase A without the kill switch tested. The deal is "flip back in one env var".

## Open questions to decide before Track A4

1. **Goose config path knob.** Does goose 1.x (May 2026) support `--config <path>` or only `GOOSE_CONFIG_PATH` env? Verify in Track A3 smoke. If neither, accept `~/.config/goose/config.yaml` as the single per-host config (safe — agents host runs as one user).
2. **`GOOSE_MODE=auto` vs interactive.** Goose has a permission model that can prompt; that hangs a worker. Pin `GOOSE_MODE=auto` (auto-approve all tool calls inside the worktree). Document the security model: per-job worktree, MCP-only side effects, no shell escape.
3. **DeepInfra spend cap.** Set a hard cap on the DeepInfra account itself if their dashboard supports it. Belt-and-braces with the soft alert in B4.

## References (load on demand)

- This conversation, 2026-05-08 (3 architect rounds, model selection, harness selection).
- Architect verdict: Qwen3-Coder-480B over Kimi-K2 (3-4× cost, no multi-turn MCP gain), over Gemma 3 (chat model), over DeepSeek-V4-Pro (price parity with Kimi, no public BFCL/tau-bench numbers yet — revisit in 60 days).
- `src/worker/index.js:136–230` (`spawnAgent`, current Claude driver).
- `src/server/webhooks-github.js` (full file, 207 lines).
- `src/worker/workflows/merge-coordinator.yaml` (18 lines, replace).
- `src/worker/dispatch.js:131–257` (`enqueueWorkflowStart`, untouched both phases).
- Memory: `mcp_zod_record_trap.md`, `infra_cross_repo_routing.md`, `agent_drift_2026-04-22.md`.
- Goose docs: https://block.github.io/goose/ (recipes, providers, MCP extensions).
- DeepInfra OpenAI-compat: https://deepinfra.com/docs/openai_api
- Qwen3-Coder model page: `Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo` on DeepInfra (FP4, $0.30/$1.00/$0.10 cached, 262K context, function calling + JSON mode).
