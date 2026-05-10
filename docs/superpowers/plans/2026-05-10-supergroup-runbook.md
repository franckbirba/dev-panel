# Studio supergroup runbook (DEVPA-185 step 6)

This is the manual operator runbook for bringing the Telegram supergroup
online. The code path is shipped (Step 5+6) — what's left is the
deliberately-manual provisioning Telegram requires.

**Status when complete:** `notifyEvent()` writes to the supergroup *in
addition to* DMs, with `message_thread_id` pointing at the right topic
per event kind.

## Prerequisites

- Step 1-5 of agent interactivity v2 deployed (see
  `2026-05-09-agent-interactivity-v2-design.md`).
- `studio_members` populated for all 5 humans (use `dev-panel studio set`
  per `src/cli/commands/studio.js`).
- Franck's legacy bot (`TELEGRAM_BOT_TOKEN`) ready to be added to the
  supergroup as a regular member.

## Manual steps (Franck)

1. **Create supergroup in Telegram.** New group → switch to supergroup
   (any group with > 200 members, or via supergroup-specific actions).
   Name suggestion: `devpanl-studio`.

2. **Enable forum topics.** Group → Edit → Topics ON. This converts the
   group into a forum-style supergroup with threadable topics.

3. **Add the legacy bot as a regular member.** Add `@franck_bot` (or
   whatever the username is) to the supergroup. **Do not** make it admin
   — regular member is enough to read + post in topics it's invited to.

4. **Create the 6 topics manually** in the Telegram UI:
   - `#general` — morning digest, miscellany.
   - `#DEVPA` — per-project (devpanl).
   - `#ZENO` — per-project (zeno).
   - `#EDMS` — per-project (edms).
   - `#deploys` — cross-cutting deploys + GlitchTip errors.
   - `#captures` — cross-cutting capture promotions.

   Add the bot to each topic so it can post (Telegram requires explicit
   per-topic membership for non-admin bots).

5. **Read each topic's `message_thread_id`.** Open the topic, look at the
   URL: `t.me/c/<chat_id>/<thread_id>`. Or hover the topic title in
   desktop Telegram — the thread id appears in the tooltip. Note them
   down.

6. **Run the probe script** to verify the bot can actually post in each
   topic, and to print the env block:

   ```bash
   ssh deploy@77.42.46.87
   cd ~/dev-panel
   TELEGRAM_BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN .env.production | cut -d= -f2-) \
   SUPERGROUP_CHAT_ID=-100<chat_id_from_step_5> \
   SUPERGROUP_TOPICS="general:1,DEVPA:2,ZENO:3,EDMS:4,deploys:5,captures:6" \
     node scripts/supergroup-probe.js
   ```

   The script sends a probe message to each topic and prints the env
   block to add. Expected output ends with:

   ```
   SUPERGROUP_ENABLED=true
   SUPERGROUP_CHAT_ID=-100<id>
   SUPERGROUP_TOPIC_GENERAL=1
   SUPERGROUP_TOPIC_DEVPA=2
   SUPERGROUP_TOPIC_ZENO=3
   SUPERGROUP_TOPIC_EDMS=4
   SUPERGROUP_TOPIC_DEPLOYS=5
   SUPERGROUP_TOPIC_CAPTURES=6
   ```

7. **Edit `.env.production`** on the services VPS to include the env
   block from step 6. Edit `.env` too (compose env-file precedence trap
   per `infra_plane_caveats.md`).

8. **Restart `devpanel-api`** to pick up the new env:

   ```bash
   docker compose up -d --no-deps devpanel
   docker compose logs --tail 30 devpanel | grep -i supergroup
   ```

9. **Smoke-test** by triggering a `deploy` event and watching `#deploys`.
   E.g. push a tiny change to main and confirm the deploy notification
   lands both as a DM (to Franck, the only `can_deploy` member) and in
   the `#deploys` topic.

## Rollback

Set `SUPERGROUP_ENABLED=false` (or remove the line) in `.env` /
`.env.production` and restart `devpanel-api`. Notifications fall back to
DM-only — the supergroup write path is no-op when the flag is unset.

## Notes

- **Per-dev paired bots stay DM-only.** Only the legacy `franck_bot`
  joins the supergroup. One bot in the group = one poller in the bot's
  process = no 409-Conflict storm. If a future use case needs Edwin's
  bot to post in the supergroup, that's a different design (separate
  process, separate token).

- **Chatter filter.** When humans chat in topics directly, the
  adapter-layer filter (Step 4) drops their messages from Shelly's
  context unless they `@shelly`, reply to her, or use a
  `[thread:type/id]` tag. That's enforced in
  `plugins/telegram-multi/server.ts` via `studioMembers.has(senderId)`
  + the mention/reply/tag check in `gate()`.

- **Authorization on gated actions** (deploy, approve_merge) reads
  `studio_members.can_deploy` / `can_approve_merge` per
  `src/server/studio-members.js#isAuthorized()`. Until the inbox
  callback handler enforces this (follow-up to DEVPA-185 if needed),
  the adapter filter is the only gate.

## References

- Spec: `docs/superpowers/specs/2026-05-09-agent-interactivity-v2-design.md`
- Probe: `scripts/supergroup-probe.js`
- Routing: `src/server/notify-routing.js`
- Spec invariant: single Telegram poller per token
  (`infra_shelly_bot_deployment.md`).
