# Human-in-the-loop — Pause-and-resume primitive for ephemeral agents

**Date:** 2026-05-09
**Status:** SUPERSEDED by `2026-05-09-agent-interactivity-v2-design.md` after two architect review rounds. Kept for archaeology. Do not implement from this file.
**Author:** franck-cto (Opus 4.7) + Franck

## Problem

The studio operates as fire-and-forget batch jobs. Telegram and the dashboard surface plenty of *information* (Shelly notifications, fleet view, captures), and Franck can *initiate* work (plan a cycle, draft work items, dispatch jobs). But once a `claude -p` agent is running, both surfaces collapse to a one-way log relay. Franck cannot:

- **Unblock a stuck job** waiting for clarification — he must kill+restart, losing context.
- **Restart in-place** from a notification.
- **Ask the agent "what happened?"** mid-run.
- **Provide precision/correction** to a paused agent ("use library X not Y") and let it resume.
- **Approve/deny a tool-use prompt** the agent surfaces — `--dangerously-skip-permissions` (`src/worker/index.js:186`) turns approval into a non-feature.

Concrete evidence: Telegram screenshot (2026-05-09 18:27) shows `[builder] BLOCKED`, `[pm] DONE`, `[builder] FAILED (parseResult: …)`, `[capture-new]` — every line is a dead-end log. Fleet view (`src/dashboard/views/fleet-view.jsx:135-149`) has a reply composer that *looks* like it talks to the agent — it doesn't, because no process is listening.

The architectural truth: ephemeral `claude -p` exits, and that's it. There is no inbox the agent reads while running, no `block-and-await-human` step, no Shelly-mediated channel from human → running agent → back. The studio lies about being interactive; in reality every interaction is post-mortem triage.

This costs us: yesterday produced 4 captures shaped as "agent failed, restart" — every one of them was the agent stuck on a question Franck could have answered in 10 seconds.

## Solution overview

Introduce three primitives that, together, turn fire-and-forget into pause-and-resume **without making the worker long-lived**:

1. **`job_inbox` table** — durable per-job message channel, polled by the agent.
2. **`await_human` MCP tool** — blocking call the agent uses to ask Franck a question and resume on reply.
3. **`awaiting_input` workflow status** — a real state with a resume contract, distinct from `blocked` (terminal) and `awaiting_approval` (existing).

The agent process stays ephemeral. What becomes long-lived is the *job's logical session*, materialised in Postgres. The agent blocks on `await_human` (HTTP long-poll against the API), the worker process is just the host of that subprocess. On timeout, the agent emits a `BLOCKED` summary and exits cleanly; on reply, the inbox row is consumed and the agent continues.

Telegram and the dashboard become two clients of the same `/api/jobs/:id/inbox` endpoint. No semantic split — Telegram is mobile, dashboard is desktop, both write into the same inbox.

## Non-goals

- **Not a long-lived worker process.** The agent subprocess remains ephemeral; statefulness lives in Postgres, not in memory.
- **Not a chat-with-the-agent UI.** This is a structured Q/A primitive — agent asks, human answers, agent resumes. Free-form chat with a running agent is out of scope.
- **Not replacing thread tags.** `[thread:job/<id>]` continues to exist for post-hoc transcripts; the inbox is for in-flight steering.
- **Not a permission framework rewrite.** We replace `--dangerously-skip-permissions` with structured approval, but the policy model (autonomy, allowlist) stays as today.
- **Not retroactive.** Existing running jobs stay fire-and-forget; the new primitive opts in per agent-step.

## Architecture

### Data model

New table:

```sql
CREATE TABLE job_inbox (
  id            BIGSERIAL PRIMARY KEY,
  job_id        TEXT NOT NULL,
  seq           INT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('agent_question', 'human_reply', 'tool_request', 'tool_response')),
  content       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at   TIMESTAMPTZ,
  UNIQUE (job_id, seq)
);
CREATE INDEX job_inbox_pending ON job_inbox (job_id, consumed_at) WHERE consumed_at IS NULL;
```

`workflow_instances.status` gains `'awaiting_input'` between `running` and `awaiting_approval`. Existing `blocked` stays terminal; `awaiting_input` is resumable.

### MCP tools

In `src/mcp/server.js`:

- **`await_human({ prompt: string, timeout_s?: number, options?: string[] })`** — agent-side blocking call. Writes `{role: 'agent_question', content: {prompt, options}}` to `job_inbox` for `JOB_ID` (already injected at `src/worker/index.js:194`), flips `workflow_instances.status='awaiting_input'`, then long-polls (HTTP keep-alive, max 60s per poll, retry until timeout) for the matching `human_reply` row. Returns `{answer: string, source: 'franck'|'shelly'|'timeout-default'}`.
- **`request_tool_approval({ tool: string, args: object, default_on_timeout: 'allow'|'deny' })`** — same shape as `await_human` but typed for tool-use confirmations. Replaces today's blanket `--dangerously-skip-permissions`.

### HTTP API

- **`POST /api/jobs/:id/inbox`** (auth: project key + Shelly admin token) — body `{role: 'human_reply', content: {answer}}`. Inserts row, NOTIFYs the long-poll, transitions instance to `running`. Used by Telegram (Shelly) and dashboard.
- **`GET /api/jobs/:id/inbox?since=<seq>`** — agent long-poll endpoint. Returns the next unconsumed row or 204 after `Prefer: wait=60`.
- **`GET /api/jobs/:id/inbox/history`** — for dashboard rendering.

### Surfaces

**Dashboard.** `src/dashboard/views/fleet-view.jsx:135` already has a reply composer; route its POST to `/api/jobs/:id/inbox` when the instance status is `awaiting_input` (vs `/api/threads/*` otherwise). Add a small "agent is asking:" banner with the pending question.

**Telegram (Shelly).** When `notifyJob()` (`src/server/alerts.js`) sees status `awaiting_input`, it sends a Telegram message with native interactive controls — not just a `[thread:job/<id>]` log line. Three patterns, picked by the `await_human` call shape:

- **Multiple choice** (`options: string[]` provided) → `sendMessage` with `reply_markup: InlineKeyboardMarkup`. Each option becomes a button; `callback_data` carries `job:<id>:opt:<n>` (≤64 bytes, so we map index → option in DB, not the full string). On click, Telegram fires a `callback_query` update; our webhook handler resolves the job, writes the chosen option to `job_inbox`, calls `answerCallbackQuery` (toast: "✓ envoyé au builder"), then `editMessageText` to replace the buttons with "→ <chosen option>" so Franck sees what he picked.
- **Free-form clarification** (no options) → `sendMessage` with `reply_markup: ForceReply{selective: true}`. Franck's next Telegram message auto-becomes a `reply_to_message`; the bot reads `reply_to_message.message_id`, looks up the corresponding `job_id`, and writes the body to `job_inbox`.
- **Tool approval** (`request_tool_approval`) → inline keyboard with `[Approve] [Deny] [Amend…]`. `Approve`/`Deny` resolve immediately. `Amend…` falls through to ForceReply for the corrected args.

Outbound message_id and the corresponding `job_inbox.expected_seq` are persisted in `telegram_pending_replies(message_id, job_id, kind, options_map)` so the webhook handler can route incoming `callback_query` and `reply_to_message` events back to the right inbox row without scanning.

This requires moving from `getUpdates` polling to **webhooks** for `callback_query` + `message` updates, so the latency from tap → agent resume is sub-second. Today the `telegram-multi` plugin polls; we keep polling for free-form chat with Shelly but add a webhook handler in the API for callbacks (Telegram supports both modes if the bot uses different update_types — verify). Alternative: keep polling and let the plugin fan callbacks into `job_inbox` via the existing MCP — adds 1-2s latency but no infra change. Phase 2 ships the polling variant; webhook is Phase 4 if latency matters.

Shelly's `SOUL.md` gets one paragraph: when a `[thread:job/<id>]` reply is received and the instance is `awaiting_input`, POST to `/api/jobs/:id/inbox` instead of `thread_append`. (This is the typed-text fallback when Franck ignores the inline keyboard and just writes a sentence.)

### Telegram render primitives

The interactive shapes above (inline keyboard, ForceReply, approve/deny) are the load-bearing ones. Beyond that, four cheap render primitives ride the same inbox flow without adding state:

1. **Inline keyboards + `callback_query`** (already covered) — multiple choice + tool approval.
2. **`ForceReply`** (already covered) — free-form clarification.
3. **`sendPhoto` / `sendDocument` on inbox messages** — agents attach a screenshot, diff, or generated artifact to the question they're asking; Franck attaches one to his reply (the inbound `image_path` plumbing already exists in `SOUL.md` for Telegram messages). Cheap, high-leverage — agents can show, not just describe.
4. **`editMessageText` for state transitions** — when a job moves `running → awaiting_input → running`, edit the original Telegram message in place rather than spamming new ones. Removes ~80% of the log-relay feeling — the message itself becomes the live status.
5. **Message reactions for one-tap approve/deny** — `👍` / `👎` on a `request_tool_approval` message resolves it without a callback button. Cheaper UX than tapping a button; one webhook handler, no new state. Ship as a fast-path alongside the inline-keyboard variant.

**Explicitly rejected** (each fails the third-time rule today):

- **`sendPoll`** — worse version of inline keyboards with anonymous-vote semantics we don't want.
- **Multi-select via toggling button labels** — real state machine. Build only when needed three times; today: zero need.
- **Date / time / project pickers** — same; dashboard already does this better with real form widgets.
- **`setMyCommands` slash menu** — pushes Shelly back toward `/issues`-style command bot. She is conversational, not a CLI.
- **WebApp / Mini App** — that *is* the dashboard with a Telegram skin. Re-auth, second build target, Telegram-specific JS bridges. If mobile UX is the pain, fix dashboard mobile breakpoints.
- **Forum topics in DMs** — N/A here; threading model lives in the separate coordination ADR.
- **`sendChatAction` "typing"** — purely cosmetic.
- **Live progress bars beyond `editMessageText`** — premature.

### Resume model

Default: agent process stays alive on the worker, idle while long-polling. This is fine if Anthropic bills on streamed tokens (verify) and if `WORKER_CONCURRENCY=3` slots aren't starved.

If concurrency starvation becomes a real problem (>3 paused jobs simultaneously): persist the agent's last assistant turn + tool state into `workflow_instances.metadata.suspended_state`, kill the subprocess, free the BullMQ slot. On reply, re-enqueue with `context.resumed_from_job_id` and replay the inbox into the new prompt. Phase 2 — not required for v1.

### Timeout / autonomy fallback

`await_human` accepts `timeout_s` (default 1800s = 30min). On timeout:

- `metadata.autonomy='high'` → tool returns `{answer: '<safe-default>', source: 'timeout-default'}`, agent picks the safe default and continues. The agent's prompt must declare what "safe default" means for this question.
- `metadata.autonomy='low'` → tool throws `HumanTimeoutError`, agent emits a `BLOCKED` summary into the existing exhaustion path (already at `src/server/routes-fleet.js:225-254`).

`request_tool_approval` defaults: `agent=deploy` → deny on timeout, `agent=builder` in a worktree → allow.

## Build sequence

**Phase 1 — primitive (1-2 days).**

1. Migration for `job_inbox` table + new `awaiting_input` status.
2. `await_human` MCP tool. Wire into existing JOB_ID env injection (`src/worker/index.js:194`).
3. `POST/GET /api/jobs/:id/inbox` endpoints in `src/server/routes-fleet.js`.
4. One canary agent (suggest: `pm`, lowest blast radius) opts into `await_human` for ambiguity.

**Phase 2 — surfaces (2 days).**

5. Dashboard reply composer at `fleet-view.jsx:135` routes to inbox when status is `awaiting_input`. Add per-option buttons when `await_human.options` was set.
6. `notifyJob()` formats `awaiting_input` events as **native Telegram interactive messages**: `InlineKeyboardMarkup` for multiple choice, `ForceReply` for free-form, `[Approve][Deny][Amend…]` for tool approvals.
7. New table `telegram_pending_replies(message_id, job_id, kind, options_map)`. New handler in the `telegram-multi` plugin (or a sidecar route in `src/server/`) that consumes `callback_query` + `reply_to_message` events, looks up the pending row, writes to `job_inbox`, calls `answerCallbackQuery` + `editMessageText` to confirm visually.
8. Shelly `SOUL.md` paragraph: typed-text fallback for `[thread:job/<id>]` replies when status is `awaiting_input` → POST inbox instead of `thread_append`.

**Phase 3 — tool approvals (2 days).**

9. Replace `--dangerously-skip-permissions` (`src/worker/index.js:186`) with the Claude SDK `canUseTool` callback (verify exact flag form for `claude -p`).
10. Wire the callback through `request_tool_approval` — reuses the inline-keyboard primitive built in Phase 2 step 6.
11. Per-agent default policy table (deploy=deny, builder-in-worktree=allow, …).

**Phase 4 — webhook upgrade (only if callback latency matters, ~half day).**

12. Add a Telegram webhook endpoint to the API; switch `callback_query` + `reply_to_message` updates to webhook delivery. Keep `getUpdates` polling for free-form Shelly chat. Drops tap→agent latency from ~1-2s to sub-second.

**Phase 4 — concurrency hardening (only if needed).**

11. Suspended-state persistence + re-enqueue on reply. Skip until paused-job starvation is observed.

## Tradeoffs

- **Cost.** Idle paused agents are nearly free if Anthropic bills on streamed tokens (verify with billing semantics — not 100% sure `claude -p` with no streamed output stays at $0). Real cost is wall-clock concurrency: `WORKER_CONCURRENCY=3` (`src/worker/index.js:95`) means 3 paused jobs starve 3 fresh ones. Phase 4 mitigates if it becomes real.
- **Complexity.** Agents become observably stateful — but they were already stateful, the studio just lied about it. The lie cost 4 captures yesterday.
- **Failure modes.** Human never answers → timeout + autonomy escalation handles it. Agent crashes mid-poll → BullMQ retries spawn a fresh subprocess; the inbox replay puts it back in context. Postgres NOTIFY drops → fall back to 5s polling on the long-poll endpoint.
- **Existing thread system.** `thread_append` keeps working for transcripts. The inbox is additive, not a replacement. Some duplication for `[thread:job/<id>]` content (it lives both as a thread message and as an inbox row); accept the duplication, treat the inbox as ephemeral and the thread as the audit trail.
- **Cultural shift.** Agents will start asking questions instead of failing fast. That's good — but the prompt updates need to teach them *when* to ask (ambiguity above a threshold) vs. *when* to pick a default and continue. Wrong calibration → either agents nag every step (bad UX) or never ask (back to today). Calibrate per role in agent prompts.

## Open questions

1. Does `claude -p` accept a `canUseTool` callback over stdio, or do we need to migrate to the SDK's streaming HTTP form? (Phase 3 blocker — verify before committing.)
2. Anthropic billing while idle long-polling — confirm zero-token cost.
3. Inbox retention — keep forever (audit) or TTL after job completion (volume)?
4. Should Shelly proactively ask Franck on his behalf when an `await_human` question is "obvious" (e.g. has a memory match)? Defer — start with direct routing, layer Shelly-mediated answers later.

## References

- Concrete pain evidence: Telegram screenshot 2026-05-09 18:27 (4 BLOCKED/FAILED in 10min).
- `src/worker/index.js:148-252` — current ephemeral spawn lifecycle.
- `src/server/routes-fleet.js:225-254` — existing exhaustion / autonomy handling.
- `src/dashboard/views/fleet-view.jsx:135-149` — reply composer that needs rewiring.
- `.agents/shelly/SOUL.md` — thread tag protocol, needs one paragraph addition.
- Memory: `agent_runtime_structural_2026-05-08.md` — worker-as-commit-authority decision establishes the precedent that the worker owns lifecycle invariants, not the agent prompt.
