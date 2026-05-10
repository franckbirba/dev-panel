# Studio coordination surface — Telegram supergroup with forum topics

**Date:** 2026-05-09
**Status:** SUPERSEDED by `2026-05-09-agent-interactivity-v2-design.md` after two architect review rounds. Kept for archaeology. Do not implement from this file.
**Author:** franck-cto (Opus 4.7) + Franck

## Problem

Today every Shelly notification — morning digest, deploys, shipped PRs, GlitchTip errors, capture promotions, agent failures — goes to **Franck's DM only**. As the studio onboards Edwin, Alex, and others, this stops scaling:

- **N-broadcast tax.** Franck has to forward "deploy went out" / "build broke" / "ZENO-42 shipped" to each dev one by one. Either the facts get duplicated N times in N DMs, or the team operates on stale information.
- **No shared situational awareness.** Edwin doesn't see what Alex is working on. Alex doesn't see that the prod errors spike correlates with Edwin's PR. The studio fact-stream lives only in Franck's head and Franck's DM.
- **No agent-to-team channel.** When an agent finishes a workflow on a project Edwin owns, the only way Edwin learns is if Franck DMs him. Today the agent literally can't address the team.
- **DMs collide with HITL.** The HITL ADR (`2026-05-09-human-in-the-loop-design.md`) routes `await_human` questions to DMs. As DMs also fill with broadcast traffic, the signal gets buried.

The studio is moving from 1-Franck-with-agents to N-humans-with-agents. The communication surface must follow.

## Solution overview

**One Telegram supergroup with forum topics**, joined by the legacy `franck` bot acting as the studio voice (Shelly). Per-project topics + two cross-cutting topics (`#deploys`, `#captures`). Studio facts go to the supergroup; personal decisions stay in DMs. Per-dev paired bots remain DM-only — no second poller.

This is the partition:

| Surface | What lives there |
|---|---|
| **Supergroup (shared)** | Morning digest, deploys, shipped PRs, GlitchTip prod errors, capture promotions for project-scoped captures, agent workflow completions. *Studio facts.* |
| **DM (1:1)** | `await_human` questions (routed to the requester), personal capture triage when Franck is the author, deploy approvals (per-person gate), pairing flow (`/pair`), Shelly chit-chat. *Personal decisions.* |

Heuristic: if it answers "what is the studio doing?" → supergroup. If it answers "what does *this human* need to decide?" → DM.

## Non-goals

- **Not per-purpose broadcast channels.** (Rejected — 4-6 channels to subscribe to + N webhook routes; ForceReply doesn't work in channels, downgrades HITL.)
- **Not a second Shelly instance for the team channel.** (Rejected — two pollers = 409 hell + split memory. Discipline lives in prompt filters, not duplicated processes.)
- **Not replacing per-dev paired bots.** They keep working for personal DMs; only Franck's legacy bot joins the supergroup.
- **Not migrating existing DM flows wholesale.** Only the broadcast subset moves; HITL stays DM-routed by default.
- **Not a public/external chat.** Invite-only supergroup, same threat model as the current studio Telegram surface.

## Architecture

### Topology

```
Franck's legacy bot (8661…)
  ├─ DM with Franck (today, unchanged)
  ├─ DM with Edwin / Alex / … (today, unchanged for personal decisions)
  └─ Supergroup "devpanl-studio"
       ├─ #general
       ├─ #DEVPA   (per-project)
       ├─ #ZENO    (per-project)
       ├─ #EDMS    (per-project)
       ├─ #deploys (cross-cutting)
       └─ #captures (cross-cutting inbox feed)
```

Per-dev paired bots (Edwin's, Alex's, …) **do not** join the supergroup. They remain DM-only pollers serving their owner's personal flow. One supergroup, one bot in it, one poller — no 409s, no split memory.

### Topic taxonomy — per-project, not per-cycle, not per-purpose

- **Per-project** matches how Franck thinks (Plane projects align 1:1) and how agents are dispatched. New project = new topic.
- **Per-cycle** rejected: sprint ends → topic dies → archive cost compounds.
- **Per-purpose** rejected: 4 purposes × 3 projects = 12 topics, the supergroup becomes unreadable.
- **Two cross-cutting exceptions:** `#deploys` (every project deploys; one place to watch) and `#captures` (the inbox feed already crosses projects in `inbox-view.jsx`).

### Routing rules — codified

New table:

```sql
CREATE TABLE telegram_routing (
  event_kind     TEXT NOT NULL,          -- 'morning_digest', 'deploy', 'pr_shipped', 'glitchtip_error', 'capture_promoted', 'workflow_completed'
  project        TEXT,                   -- nullable; matched against routing key
  destination    TEXT NOT NULL,          -- 'supergroup:#<topic>' or 'dm:<tg_user_id>'
  PRIMARY KEY (event_kind, project)
);
```

Default seed:

| event_kind | project | destination |
|---|---|---|
| `morning_digest` | * | `supergroup:#general` |
| `deploy` | * | `supergroup:#deploys` |
| `pr_shipped` | DEVPA | `supergroup:#DEVPA` |
| `pr_shipped` | ZENO | `supergroup:#ZENO` |
| `pr_shipped` | EDMS | `supergroup:#EDMS` |
| `glitchtip_error` | * | `supergroup:#deploys` (errors are deploy adjacent) |
| `capture_promoted` | * | `supergroup:#captures` |
| `workflow_completed` | DEVPA | `supergroup:#DEVPA` |
| `workflow_completed` | ZENO | `supergroup:#ZENO` |
| `workflow_completed` | EDMS | `supergroup:#EDMS` |
| `await_human` | * | `dm:<requester_tg_user_id>` (HITL stays personal) |
| `tool_approval` | * | `dm:<requester_tg_user_id>` |
| `pair_dev_bot` | * | `dm:<franck_tg_user_id>` |

`notifyJob()` (`src/server/alerts.js`) and the new `notifyEvent()` helper resolve destination from this table before calling `sendMessage`. Adding a route = INSERT, not code change.

### Telegram primitives in topics

- **Inline keyboards + `callback_query`** work in topics (bot needs to be a member). Last-clicker-wins by Telegram default — we record `from.id` in the callback handler and apply policy:
  - For **studio facts** posted to a topic (e.g. "deploy succeeded, 👍 to ack"): first click wins, all team members allowed.
  - For **gated actions** routed to a topic (e.g. an `await_human` question that landed in `#DEVPA` because routing said so): require `from.id ∈ project.maintainers` else `answerCallbackQuery` with "not authorized" toast.
- **`ForceReply`** works inside topics. Used by `await_human` when routed to the supergroup (rare — most stay DM).
- **Reactions** work on topic messages. `👍` / `👎` on a tool-approval prompt resolves it (if the reactor is authorized).
- **`message_thread_id`** is Telegram's native topic id. Already-existing app-level `[thread:…]` tags are orthogonal — they identify business threads (capture/work_item/job), not Telegram topics. Keep both: `[thread:job/<id>]` continues to mean "this message belongs to job X's conversation"; `message_thread_id` means "post this in #DEVPA topic". An outbound message can have both: posted in `#DEVPA` *and* tagged `[thread:job/abc]`.

### Shelly's listening filter (one paragraph in `SOUL.md`)

In topics, **default-ignore** all messages. Shelly only reacts when:

1. Addressed directly: `@shelly` mention or `reply_to_message.from.id == shelly_bot_id`.
2. The message carries a `[thread:…]` tag matching an in-flight subject she's tracking.
3. A `callback_query` arrives whose `callback_data` she issued.

Plain human chatter in `#DEVPA` is dropped at the ingest filter — same shape as today's `[builder]` log filter, just inverted (default ignore unless tagged). This is prompt discipline, not architecture: one paragraph in SOUL, no new code beyond the existing channel-message handler.

In DMs, behavior is unchanged — Shelly reacts to everything from her paired user.

### Bot membership & permissions

- Franck creates the supergroup, enables forum topics, invites the legacy `franck` bot (`8661…`) as a regular member (not admin — admin is overkill, regular member can post + read in topics it's been added to).
- The bot needs `can_send_messages` per topic. Topic creation is manual (via Telegram UI) for v1; programmatic creation via `createForumTopic` is a follow-up if topics churn.
- Per-dev paired bots are **not** invited to the supergroup. Strictly DM-only.
- Allowlist for who can be in the supergroup is managed in Telegram (invite link / manual add) — not in our DB. The DB only knows `tg_user_id` for routing.

## Build sequence

**Phase 1 — supergroup wiring (half day).**

1. Create the `devpanl-studio` supergroup, enable topics, seed the 6 topics manually.
2. Add the legacy bot to the supergroup, verify it can post in each topic.
3. Migration for `telegram_routing` table + seed routes (table above).
4. New `notifyEvent(kind, project, payload)` helper in `src/server/alerts.js` that resolves destination from the routing table and calls `sendMessage` with `chat_id=supergroup_id` + `message_thread_id=<topic_id>` (or DM).

**Phase 2 — wire existing notifications (half day).**

5. Replace direct `chat_id=<franck>` calls in `notifyJob()`, morning digest cron, GlitchTip bridge, capture promotion handler with `notifyEvent(...)`.
6. Verify each event lands in the right topic.

**Phase 3 — interactive primitives in topics (1 day).**

7. Extend the HITL `telegram_pending_replies` handler to include `chat_id` + `message_thread_id` + `from.id` policy in the callback resolution path.
8. Authorization policy table for gated actions (`project.maintainers` per-project source — likely Plane membership lookup).

**Phase 4 — Shelly listening filter (half day).**

9. SOUL.md paragraph + handler patch in the `telegram-multi` plugin to drop topic messages that don't match the three trigger conditions above.

## Tradeoffs

- **Manual topic creation in v1.** Programmatic via `createForumTopic` is a half-day add but premature — we have 3 projects, topics rarely change.
- **Routing table is studio-wide.** A new project means INSERTing 2-3 routes (pr_shipped, workflow_completed, possibly capture_promoted). Acceptable; DDL-free.
- **One bot in the supergroup = one voice.** Edwin can't have *his* paired bot speak in the supergroup. If "agent says X to the team" needs distinct authorship, today the legacy bot says it on the agent's behalf. Acceptable until it isn't.
- **Last-clicker-wins on `callback_query`.** First valid click resolves the action; subsequent clicks `answerCallbackQuery` with "déjà résolu". Race condition is benign — last one to tap before the message-edit lands gets a friendly toast.
- **Authorization model leans on Plane membership.** If Plane is down, gated actions in topics either fail-closed (deny all) or fail-open (allow all studio members). Default fail-closed; surface in `notifyEvent` payload.
- **Cultural risk: chatter pollution.** Once humans use the supergroup for non-studio chat (memes, banter), Shelly's listening filter must hold. The third-time-rule mitigation: if she misfires three times, tighten the filter; she's never tightened it because it's never been tested.
- **Doesn't replace HITL DM routing.** `await_human` stays DM by default because pause-and-resume questions are personal. Routing one to the supergroup is a deliberate INSERT (`event_kind='await_human', destination='supergroup:#<topic>'`) — escape hatch, not default.

## Open questions

1. **Should `[builder]` / `[reviewer]` per-step logs go to topics, or stay suppressed?** Today SOUL says ignore them as DM noise. In `#DEVPA` they could be useful as a live workflow feed. Default: keep suppressed; surface only `workflow_completed` summary events. Revisit if Edwin/Alex ask for live feed.
2. **GlitchTip routing per-project.** Today `#deploys` catches all errors. Should errors fan out per-project topic instead? Wait until volume justifies — single topic is easier to scan.
3. **`message_thread_id` lookup.** We need Telegram topic IDs in the routing table. Lookup approach: bot posts a probe message in each topic at setup, captures the returned `message_thread_id`, stores it. One-shot script during Phase 1.
4. **Per-dev paired bots and group chats — ever?** Possibly: Edwin's paired bot could be invited to a private DM-style group with him + Shelly + ephemeral agents. Defer until a concrete need shows up.

## References

- HITL ADR: `docs/superpowers/specs/2026-05-09-human-in-the-loop-design.md` — this ADR depends on the inbox primitive landing first; routing rules reuse the same `[thread:…]` tag protocol.
- `src/server/alerts.js` — current `notifyJob()`, where `notifyEvent()` lands.
- `.agents/shelly/SOUL.md` — "Proactive behaviour" section, where the listening filter paragraph is added.
- Memory: `infra_shelly_bot_deployment.md` (Shelly runtime topology — single tmux session, single poller invariant), `multi_dev_shelly` ADR `docs/superpowers/specs/2026-04-25-multi-dev-shelly-design.md` (paired-bot model — explicitly preserved here).
- Telegram Bot API: forum topics (`createForumTopic`, `message_thread_id`), inline keyboards in groups, ForceReply in topics, `callback_query.from`, message reactions.
