# Agent interactivity v2 — HITL primitive + studio coordination surface

**Date:** 2026-05-09
**Status:** Design v2 — pending user review
**Author:** franck-cto + franck-architect (two review rounds) + Franck
**Supersedes:** `2026-05-09-human-in-the-loop-design.md`, `2026-05-09-studio-coordination-surface-design.md`

## Why this exists (and why it replaces v1)

v1 split the problem in two ADRs (HITL primitive + supergroup coordination). franck-architect review round 1 collapsed redundant state and primitives. Round 2 — once Franck corrected the headcount premise from "1 + Edwin incoming" to **5 humans, today** — flipped two earlier deferrals (`studio_members` table, supergroup) into "ship now," and reframed the listening filter from prompt-discipline to adapter-layer code.

Both reviews converged on one substrate:

- **One inbox primitive.** No separate `awaiting_input` / `awaiting_approval` states. No separate `await_human` / `request_tool_approval` tools. One typed payload.
- **One identity table.** `studio_members` carries identity + capability + destination. Replaces invented `telegram_routing` table for routing, ad-hoc allowlists for authz, and Plane-membership-as-authz misuse.
- **One filter layer.** Whitelist + addressing check at the `telegram-multi` adapter, not in Shelly's prompt. Otherwise 5 humans typing = context poisoning + token burn.
- **One sequencing rule.** `canUseTool` migration first — it unblocks everything else and may shrink HITL by half.

## Problem (compressed)

Today every `claude -p` agent runs fire-and-forget with `--dangerously-skip-permissions` (`src/worker/index.js:186`). Telegram + dashboard collapse to read-only logs once a job starts. Yesterday produced 4 captures shaped as "agent failed, restart" — every one was an agent stuck on a question Franck could have answered in 10s.

Concurrently: Shelly broadcasts to Franck's DM only. The studio is now 5 humans + N agents. The N-broadcast tax is being paid daily. No shared situational awareness. No agent-to-team channel.

## Solution (one substrate, four primitives)

### Primitive 1 — `studio_members` table

Identity + capability + destination, one row per human:

```sql
CREATE TABLE studio_members (
  tg_user_id          BIGINT PRIMARY KEY,
  display_name        TEXT NOT NULL,
  bot_label           TEXT,                    -- paired bot label, NULL for Franck (legacy bot)
  projects            TEXT[] NOT NULL DEFAULT '{}',
  roles               TEXT[] NOT NULL DEFAULT '{}',
  can_deploy          BOOLEAN NOT NULL DEFAULT FALSE,
  can_approve_merge   BOOLEAN NOT NULL DEFAULT FALSE,
  default_dm_chat_id  BIGINT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

This is the single source of truth for "who is this Telegram user, what can they do, where do I message them." Replaces three ad-hoc concepts:

- `dev_bot_allowlist` (today: "can this user pair a bot") — kept for pairing, not load-bearing for authz.
- Hardcoded `tg_user_id=5663177530` Franck check across SOUL.md and source.
- The "lean on Plane membership" authz fantasy from v1 ADR2.

Rows are seeded by `pair_dev_bot` (today's flow) and editable by Franck only via an `admin set-permission` CLI.

### Primitive 2 — `job_inbox` table + one `await_human` MCP tool

```sql
CREATE TABLE job_inbox (
  id            BIGSERIAL PRIMARY KEY,
  job_id        TEXT NOT NULL,
  seq           INT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('agent_question', 'human_reply')),
  kind          TEXT NOT NULL CHECK (kind IN ('clarification', 'tool_approval')),
  content       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at   TIMESTAMPTZ,
  seen_callback_ids TEXT[] NOT NULL DEFAULT '{}',
  UNIQUE (job_id, seq)
);
CREATE INDEX job_inbox_pending ON job_inbox (job_id, consumed_at) WHERE consumed_at IS NULL;
```

`workflow_instances.status` gains exactly one new state: `'awaiting_input'`. Existing `'awaiting_approval'` collapses into it (typed via `kind` on the inbox row).

One MCP tool in `src/mcp/server.js`:

```ts
await_human({
  kind: 'clarification' | 'tool_approval',
  prompt: string,
  options?: string[],          // for clarification: multiple choice
  tool?: string,               // for tool_approval: tool name
  args?: object,               // for tool_approval: requested args
  timeout_s?: number,          // bounded ≤ 900 (see §Concurrency invariants)
  default_on_timeout?: 'allow' | 'deny' | string,
})
→ { answer: string, source: 'human' | 'timeout-default' }
```

**Hard constraint (preserves worker-as-commit-authority):** the tool returns only `{answer: string, source}`. No structured payloads the agent is tempted to act on. For `tool_approval`, the *worker* gates the actual tool call based on the answer; the agent receives the verdict as a string.

### Primitive 3 — `notifyEvent()` dispatcher (DM-first today, supergroup-ready)

A 50-line helper in `src/server/alerts.js` that resolves destination from `studio_members` + a small JS config (not a table — 6 routes, one config file beats DDL):

```js
// src/server/notify-routing.js — flat config, edit in PRs
export const ROUTES = {
  morning_digest:    { dm: 'all_active' },
  deploy:            { dm: 'all_with_can_deploy', topic: '#deploys' },
  pr_shipped:        { dm: 'project_members', topic: 'project' },
  glitchtip_error:   { dm: 'project_members', topic: '#deploys' },
  capture_promoted:  { dm: 'project_members', topic: '#captures' },
  workflow_completed:{ dm: 'requester', topic: 'project' },
  await_human:       { dm: 'requester' },           // HITL stays personal
  tool_approval:     { dm: 'requester' },
};
```

`notifyEvent(kind, project, payload)` resolves the rule, looks up `studio_members`, sends to DMs today. **Supergroup writes are gated behind a feature flag** (`SUPERGROUP_ENABLED=false` initially) — same code path, second destination flipped on once the supergroup actually exists. This decouples "ship N-fanout" from "ship supergroup" without two ADRs.

`notifyJob()` callers across `src/worker/automation.js` migrate to `notifyEvent()` over Phase 1.

### Primitive 4 — adapter-layer whitelist filter in `telegram-multi`

Inbound message handling moves from "everything reaches Shelly's prompt" to a structured rule, **before** the LLM:

```ts
// telegram-multi adapter, pre-Claude
function shouldRouteToShelly(msg) {
  if (msg.chat.type === 'private') {
    return studio_members.has(msg.from.id);   // DM to paired bot
  }
  if (msg.chat.type === 'supergroup') {
    if (msg.entities?.some(e => e.type === 'mention' && e.user.id === BOT_ID)) return true;
    if (msg.reply_to_message?.from?.id === BOT_ID) return true;
    if (msg.text?.match(/^\[thread:[a-z_]+\/[a-f0-9-]+\]/)) return true;
    return false;
  }
  return false;
}
```

Drops at the adapter = no token burn, no context poisoning. Shelly's `SOUL.md` continues to describe behavior; the adapter enforces eligibility. **This is round-2's single biggest reversal:** prompt-discipline alone does not hold at headcount=5.

## Non-goals

- **No second Shelly instance for the supergroup.** One process, two chat types, single poller (preserves the 409-Conflict-free invariant from `infra_shelly_bot_deployment.md`).
- **No `telegram_pending_replies` side table.** `callback_data` carries `inbox:<inbox_id>:<idx>` (≤30 of 64 bytes). ForceReply keys on `reply_to_message.message_id`, looked up via `job_inbox` directly.
- **No `request_tool_approval` separate tool.** Same primitive, typed payload via `kind`.
- **No `awaiting_approval` separate state.** Collapsed.
- **No `telegram_routing` table.** Config file in `notify-routing.js`. Promote to table at row 30+.
- **No multi-select / pickers / WebApp / polls / slash menus / sendChatAction / progress bars.** Each fails the third-time rule today (full reject list in v1 ADR1, preserved here by reference).
- **No `telegram-multi` extraction this iteration.** `[blindspot:library-trying-to-escape]` flagged — extract Q3 once supergroup proves the actual API surface. Premature extraction = premature abstraction.

## Concurrency invariants (Phase 1, not Phase 4)

`WORKER_CONCURRENCY=3` (`src/worker/index.js:96`) + `lockDuration=1800000` (`:431`) + default v1 `timeout_s=1800` = exact deadlock by lunch on the first triple-pause. Round-1 architect catch.

**v1 invariant: `timeout_s` is bounded ≤ 900 (= lockDuration/2).** The MCP tool clamps. On timeout the agent gets the `default_on_timeout` answer and resumes; if the agent then re-asks, that's a fresh inbox row, not a stale lock.

**Phase 4 (suspended-state persistence + slot release) is a follow-up**, opened only if observed paused-job density actually starves new jobs. With ≤900s timeout and 3 slots, starvation requires 3 simultaneous pauses sustained for 15 min — possible but not yet observed.

## Idempotency & cancellation

- **`callback_query` retries.** Telegram fires retries when `answerCallbackQuery` is slow >3s. The webhook handler:
  1. Checks `callback_query.id ∈ job_inbox.seen_callback_ids` → respond with cached `answerCallbackQuery` text, no second write.
  2. Otherwise: BEGIN; UPDATE inbox row WHERE `consumed_at IS NULL` SET `consumed_at=NOW(), seen_callback_ids=array_append(...)`, INSERT `human_reply` row; COMMIT. Lost-update protection comes from the `consumed_at IS NULL` predicate.
- **Second tap after `editMessageText`.** Resolves to step 1 (id already seen) or step 2 (consumed_at already set → toast "déjà résolu"). No double-write.
- **Cancellation while paused.** `cancel_job` (`src/worker/index.js:110`) currently `process.kill()`s the subprocess. Add: when a workflow_instance in `awaiting_input` is cancelled, ALSO mark all unconsumed inbox rows for that `job_id` with `consumed_at=NOW(), role='cancelled'`, and orphan-handle the Telegram message via `editMessageText`("→ annulé"). Otherwise the workflow_instance row becomes a zombie.

## Resume model — pick one now (resolved from v1 Open Questions)

v1 said "agent process stays alive on the worker, idle while long-polling. Verify Anthropic billing." That assumption is load-bearing for the choice and remained unverified.

**v2 picks the safer path: kill subprocess on `await_human`, replay inbox on resume.**

- `await_human` writes the `agent_question` row, releases the BullMQ slot via `job.moveToDelayed()` (or equivalent suspended state).
- Worker re-spawns on `human_reply` write (NOTIFY-driven; 5s polling fallback). New subprocess receives `context.resumed_from_inbox_seq=<seq>`; the prompt-builder replays the question + answer pair and continues.
- Cost: idle paused jobs are zero-token regardless of Anthropic billing semantics. Trade: re-spawn warmup ~3s. Acceptable for human-scale interactions.

This collapses Phase 1 and Phase 4 from v1 into one path. **Worth re-validating with franck-cto** because it changes the resume substrate — but architect's review correctly flagged "verify" as not-shippable.

## Build sequence (UX-first, days)

| # | Step | Days | Depends on |
|---|---|---|---|
| 1 | **Inbox primitive.** `job_inbox` migration + `await_human` MCP tool + dashboard reply composer at `fleet-view.jsx:135` + `awaiting_input` workflow status. Proves the round-trip end-to-end on the dashboard side first. | 2 | — |
| 2 | **Telegram interactivity.** Inline keyboard / ForceReply for `await_human` events. `callback_query` + `reply_to_message` handlers route to `/api/jobs/:id/inbox`. `editMessageText` updates after resolution. | 1 | 1 |
| 3 | `studio_members` table + seed (5 rows: Franck + 4 devs) + admin CLI to edit. | 1 | — (parallel with 4) |
| 4 | Adapter-layer whitelist filter in `telegram-multi`. Drops chatter before LLM. | 1 | 3 |
| 5 | `notifyEvent()` DM-fanout. Flat routes config in `notify-routing.js`. Wire `notifyJob()` callers across `src/worker/automation.js`. `SUPERGROUP_ENABLED=false` flag. | 1 | 3 |
| 6 | Supergroup creation (manual: create group, enable topics, add legacy bot, probe `message_thread_id`s). Routes config flips `SUPERGROUP_ENABLED=true`. | 0.5 | 5 |
| 7 | (Q3) Extract `telegram-multi` → purpose-built `studio-bot` grammy service. Defer until 1-6 prove the API surface. | — | — |

**Total Steps 1-6 ≈ 6.5 days.** UX delivered after Step 2 (3 days in). The rest is multi-human plumbing that becomes load-bearing because the team is now 5 people.

### What's deliberately NOT in this spec

- **No tool-level permission rewrite.** `--dangerously-skip-permissions` (`src/worker/index.js:186`) stays as-is for now. The UX problem ("agent stuck, can't reply") is solved at the application layer via `await_human` — a tool the agent calls explicitly when it needs human input. Tool-use approval (intercepting Bash/Edit before the agent runs them) is a different problem with a different blast radius — addressed in a separate ADR if/when it becomes a concrete need.
- **No SDK migration.** The architecture uses `claude -p` (and `pi`/`mini-swe`/`goose` per the harness routing in `src/worker/index.js`). The CLI does not expose a `canUseTool` callback — that's a TS/Python SDK package-level feature, and switching to the SDK package would mean rewriting `spawnAgent`. Not on the UX path. Per-harness permission posture stays whatever each harness uses today; HITL rides the MCP layer, harness-agnostic.

## Telegram render primitives (kept and rejected)

**Kept (ride the inbox, no new state):**
1. Inline keyboards + `callback_query` — multiple choice + tool approval.
2. `ForceReply` — free-form clarification.
3. `editMessageText` for state transitions — replaces "agent is asking" prompt with "→ approved by Edwin" once resolved.

**Deferred to a follow-up "Telegram surface UX" doc** (round-1 catch — not load-bearing for HITL):
- `sendPhoto` / `sendDocument` on inbox messages.
- Message reactions for binary approve/deny.

**Rejected (full list preserved from v1 ADR1):** `sendPoll`, multi-select via toggling labels, date/time/project pickers, `setMyCommands`, WebApp / Mini App, `sendChatAction`, live progress bars.

## OSS posture

`telegram-multi` is past the fork point. Document the smell, defer the extraction to Q3 when supergroup + adapter filter + ForceReply + per-person authz check have stabilized into an actual API surface worth porting. Don't extract while the shape is still moving.

`await_human` is a thin MCP tool wrapping a Postgres inbox + HTTP long-poll. No external library buys us much here — the equivalent shape exists in LangGraph (`interrupt()`) and OpenAI Assistants (`requires_action`), but adopting either drags in a runtime we don't want and operates above our `claude -p` / `pi` / `goose` harness layer rather than below it.

## Tradeoffs

- **One state vs two.** Round-1 collapsed `awaiting_approval` into `awaiting_input`. Cost: less self-documenting in dashboard rendering. Mitigation: render `kind` from the inbox row as a badge ("question" vs "tool approval").
- **Config file vs table for routes.** 6 routes → flat config wins. The day a non-Franck human edits routes, promote to a table. Until then, edit-in-PR is the audit trail.
- **Kill+replay vs idle-poll.** Kill+replay pays a 3s re-spawn and one prompt-cache miss per resume. Idle-poll might be cheaper *if* Anthropic doesn't bill on idle, which is unverified. Pick the safer path now; revisit if billing is confirmed zero-cost on idle long-polls.
- **Adapter filter drops human chatter before Shelly sees it.** Cost: Shelly cannot proactively notice "the team is debating X in #DEVPA, I should chime in" because she literally doesn't see it. Acceptable v1 — opt back into specific topics with explicit `@shelly` mention. Promote to a "Shelly listening tier" feature later if needed.
- **No `telegram_pending_replies` table.** All routing context lives in `callback_data` (≤64 bytes) or `reply_to_message.message_id` (resolves via DB lookup on `job_inbox`). Fewer moving parts; one table, not three.

## Open questions

1. **NOTIFY-as-primary on a memory-pressured VPS.** `infra_services_vps_memory_pressure.md` says dockerd starves under OOM. Default the resume trigger to 5s polling; treat NOTIFY as the optimization. Acceptable latency for human-scale interactions.
2. **`message_thread_id` discovery.** Topic IDs are returned only on bot's first message in each topic. Step 6 needs a one-shot probe script that posts "Shelly online" to each topic and captures the thread IDs. Trivial; flag for the deploy runbook.
3. **Per-project authz source.** Reading `studio_members.projects[]`. Who edits this? Today: Franck via admin CLI. If it churns weekly, reconsider — possibly bind to Plane membership *as a sync*, not as a runtime dep.

## References

- `src/worker/index.js:96` (concurrency), `:110` (cancel), `:186` (skip-permissions), `:194` (JOB_ID env), `:431` (lockDuration)
- `src/server/alerts.js:230-281` — `notifyJob()` callers
- `src/mcp/server.js` — where `await_human` lands
- `src/dashboard/views/fleet-view.jsx:135-149` — reply composer to rewire
- `.agents/shelly/SOUL.md` — listening behavior; adapter filter is enforcement, SOUL is description
- `infra_shelly_bot_deployment.md` — single-poller invariant (preserved)
- `agent_runtime_structural_2026-05-08.md` — worker-as-commit-authority (preserved via `await_human` returning `{answer: string, source}` only)
- `feedback_telegram_ui_scope.md` — Telegram-as-UI scope discipline (referenced)
- v1 ADRs (superseded but kept for archaeology): `2026-05-09-human-in-the-loop-design.md`, `2026-05-09-studio-coordination-surface-design.md`
