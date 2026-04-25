# Multi-dev Shelly — design

**Date:** 2026-04-25
**Owner:** Franck
**Status:** Draft, awaiting review

## Problem

Shelly today is a single-tenant agent: one tmux Claude session on `hetzner-vps`, polling exactly one Telegram bot token from `~/.claude/channels/telegram/.env`. Only Franck can talk to her.

The studio is growing. Three more devs are joining. Each has their own Telegram bot token (created via @BotFather) and wants to chat with Shelly the same way Franck does — ask status, dispatch jobs, triage captures, get build notifications. They are all on the same team; no privacy isolation is required.

The constraint that makes this non-trivial: **Telegram allows exactly one `getUpdates` consumer per bot token.** A naive "two pollers, one token" setup returns `409 Conflict` and silently loses messages. So scaling the conversation surface means scaling the *number of tokens*, not the number of pollers per token.

## Goals

- Each paired dev DMs *their own* Telegram bot and reaches Shelly.
- Shelly remains a single Claude process — one persona, one shared studio memory, no fleet of mini-Shellys.
- Onboarding a new dev takes one `/pair` message from Franck. Zero `.env` edits, zero deploys.
- All paired devs get full Shelly powers (dispatch, triage, status). Production deploys stay gated to Franck.
- The existing single-bot setup keeps working with zero migration friction.

## Non-goals

- Per-dev privacy / scoping. Open studio: everyone sees everything Shelly sees.
- Per-dev permission tiers (read-only mode, training wheels, etc.). All-or-nothing — pair = full powers.
- Encryption-at-rest for bot tokens. Postgres on private network is the trust boundary; same as `.env.production` today.
- Self-service revocation by the dev whose bot it is. Franck revokes via API/CLI.
- Fanning out digests / `notifyJob` to all paired devs. v1 keeps push-notifications targeting Franck only.
- Load handling. 4 bots is not load.

## Architecture

One Claude process, N grammy Bot instances inside it, shared studio memory.

```
┌────────────────────────────────────────────────────────────────┐
│  hetzner-vps  (agents node, 10.0.0.3)                          │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  tmux session: shelly                                    │  │
│  │  └─ claude --channels plugin:telegram-multi@devpanl      │  │
│  │     (forked plugin, one Claude process)                  │  │
│  │                                                          │  │
│  │     ┌─ grammy Bot #1 ── token Franck    ─ getUpdates ──┐ │  │
│  │     ├─ grammy Bot #2 ── token Alice     ─ getUpdates ──┤ │  │
│  │     ├─ grammy Bot #3 ── token Bob       ─ getUpdates ──┤ │  │
│  │     └─ grammy Bot #N ── token <new>     ─ getUpdates ──┘ │  │
│  │     each inbound tagged with bot_label + tg_user_id     │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  BullMQ worker (unchanged) — spawns ephemeral claude -p        │
└────────────────────────────────────────────────────────────────┘
                            │
                            │ shared
                            ▼
┌────────────────────────────────────────────────────────────────┐
│  services VPS  (10.0.0.2)                                      │
│  postgres ── memories (pgvector), dev_bots, threads            │
│  redis    ── BullMQ queues                                     │
│  devpanel-api ── /api/dev-bots, notifyJob() push               │
└────────────────────────────────────────────────────────────────┘
```

**Three changes to today's system, nothing else:**

1. **Forked plugin `telegram-multi`** — Apache-2.0 derivative of `claude-plugins-official:telegram` (1032 LOC, single `server.ts`, `grammy` dep). Replaces the single-token boot with N grammy `Bot` instances, one per active row in `dev_bots`. Hot-reloads on table changes via 30s poll (Postgres LISTEN/NOTIFY is a v2 nicety).
2. **`dev_bots` table** in services Postgres — registry of paired bots, source of truth for which tokens to poll.
3. **`/pair` command inside Shelly** — natural-language-ish slash command Franck DMs his own bot. Validates the token via `getMe`, inserts the row, plugin picks it up within 30s. New dev introduces themselves on first DM to their bot.

What stays unchanged: BullMQ worker, ephemeral `claude -p` jobs, `memories` (pgvector), devpanel MCP tools, `notifyJob()` push, dashboard, deploy isolation rule, `SOUL.md` persona (only two paragraphs added about pairing).

## Components

### `dev_bots` table (services Postgres)

```sql
CREATE TABLE dev_bots (
  id                   SERIAL PRIMARY KEY,
  bot_token            TEXT NOT NULL UNIQUE,         -- e.g. 8661116721:AAH...
  bot_username         TEXT NOT NULL,                -- from getMe(): "alice_devpanl_bot"
  bot_label            TEXT NOT NULL UNIQUE,         -- short label: "alice"
  owner_tg_user_id     BIGINT,                       -- captured on first inbound DM, NULL until then
  owner_first_name     TEXT,                         -- captured on first inbound DM
  paired_by_tg_user_id BIGINT NOT NULL,              -- who ran /pair (Franck's tg id today)
  paired_at            TIMESTAMPTZ DEFAULT now(),
  status               TEXT DEFAULT 'active',        -- active | revoked
  last_inbound_at      TIMESTAMPTZ
);

CREATE INDEX dev_bots_status_idx ON dev_bots(status);
```

Tokens stored in clear. Trust boundary = the Postgres instance on the private network, same as `.env.production` today.

### `telegram-multi` plugin (Apache-2.0 fork of `claude-plugins-official:telegram`)

Lives under `plugins/telegram-multi/` in the dev-panel repo (or in a separate `devpanl-claude-plugin` repo if Franck prefers — equivalent, decided at impl time). Distributed via the same `~/.claude/plugins/cache/...` mechanism.

**Boot sequence:**
1. Read DB connection from env (`PG_HOST`, `PG_DATABASE`, etc. — same vars devpanel-api uses).
2. `SELECT bot_token, bot_label FROM dev_bots WHERE status='active'`.
3. For each row, instantiate `new Bot(token)` from grammy and start its `getUpdates` long-poll.
4. **Backward-compat seed:** if the SELECT returns 0 rows AND `TELEGRAM_BOT_TOKEN` env is set, INSERT a row `(token=$TELEGRAM_BOT_TOKEN, label='franck', paired_by_tg_user_id=$TELEGRAM_CHAT_ID)`, then proceed. Existing single-bot installs migrate transparently on first start.
5. Spawn an in-process timer that re-runs the SELECT every 30s. Diff against currently-running bots: spawn new ones, `bot.stop()` revoked ones.

**Inbound message decoration:** every message that the underlying plugin currently delivers as
```
<channel source="telegram" image_path="…">…body…</channel>
```
is now delivered as
```
<channel source="telegram" bot_label="alice" tg_user_id="123456" first_name="Alice" image_path="…">…body…</channel>
```
`bot_label`, `tg_user_id`, `first_name` are the new attributes. Existing single-bot inbounds get `bot_label="franck"` so the persona logic doesn't have to special-case.

**Outbound routing:** when Claude's reply needs to be sent back, the plugin reads the `bot_label` from the channel context that started the current turn and routes the `sendMessage` through that grammy Bot. Unsolicited push messages (no inbound context — e.g., `notifyJob()` POSTs from devpanel-api) go through the bot whose `bot_label='franck'` (default fallback).

**Crash safety:** if grammy Bot #N fails (token revoked, 409 conflict, network blip), log the error, mark `dev_bots.status='revoked'` if the failure is permanent (401), schedule a retry if transient. **Other bots keep running.** Plugin process never exits because of one bad token.

**Conversation isolation:** the plugin's existing channel-scoping (which already keeps DMs separate from group chats per-token) extends naturally — each `(bot_label, tg_user_id)` pair is its own conversation thread in Claude's context. This delivers per-dev short-term conversation context for free, with shared long-term context via `memories`.

### Devpanel API endpoints (`src/server/routes.js`)

Auth: existing project key (`X-API-Key`). All endpoints scoped under `/api/dev-bots`.

- `POST /api/dev-bots` — body `{ token, label, paired_by_tg_user_id }`. Calls `https://api.telegram.org/bot<token>/getMe` to validate. On success, INSERT row with `bot_username` from the response. On failure (400/401), return 400 with the Telegram error. Dedupe on `bot_token` UNIQUE — return 409 with the existing row if already paired.
- `GET /api/dev-bots` — list all rows (active + revoked). For dashboard view + Shelly's own self-introspection.
- `DELETE /api/dev-bots/:id` — UPDATE status='revoked'. Plugin picks it up within 30s.
- `PATCH /api/dev-bots/:id/owner` — internal call from the plugin once it captures `owner_tg_user_id` / `owner_first_name` on first DM. Body `{ owner_tg_user_id, owner_first_name }`.

### Shelly persona update (`.agents/shelly/SOUL.md`)

Add a "Pairing protocol" section (~30 lines) covering:
- Recognizing `/pair <token> <label>` from Franck (allowlist check on inbound `tg_user_id`).
- Validating, calling `POST /api/dev-bots`, replying with the success/failure phrasing.
- Recognizing first-time inbounds (`owner_tg_user_id IS NULL` in dev_bots) and capturing the owner via `PATCH /api/dev-bots/:id/owner`, then introducing herself.
- The deploy gate: when any dispatch with `agent=deploy` arrives from a `tg_user_id` not in `DEPLOY_ALLOWED_TG_USER_IDS`, refuse and offer to draft+forward to Franck.

The existing voice/tone/tool-restriction rules in `SOUL.md` are unchanged.

## Data flows

### Pairing — Alice's first day

```
1. Alice → @BotFather → creates "alice_devpanl_bot" → gets token T_alice
2. Alice → Franck (out-of-band): "voilà mon token: T_alice"
3. Franck → DMs his own bot: "/pair T_alice alice"
4. Plugin delivers inbound to Claude with bot_label="franck" tg_user_id=5663177530
5. Shelly recognizes /pair, allowlist check passes, calls
   POST /api/dev-bots {token: T_alice, label: "alice", paired_by_tg_user_id: 5663177530}
6. API validates via getMe → bot_username="alice_devpanl_bot" → INSERT row
7. Within 30s, plugin's hot-reload tick spawns a new grammy Bot for T_alice
8. Shelly replies to Franck via his bot: "OK, alice_devpanl_bot est en ligne. Dis à Alice de me dire bonjour."
9. Alice → DMs alice_devpanl_bot: "salut"
10. Plugin delivers inbound with bot_label="alice", tg_user_id=<Alice's TG id>, first_name="Alice"
11. Shelly notices owner_tg_user_id IS NULL for label="alice", calls
    PATCH /api/dev-bots/:id/owner {owner_tg_user_id, owner_first_name}
12. Shelly replies through Alice's bot: "Salut Alice, je suis Shelly. Je vois Franck a paire ton bot.
    Tu peux me demander 'ça donne quoi?' pour le pulse, ou 'lance ZENO-42' pour dispatch."
```

### Normal use — Bob asks for status

```
Bob → bob_devpanl_bot (grammy Bot #3) → plugin → Claude
  inbound: <channel bot_label="bob" tg_user_id=999 first_name="Bob"> ça donne quoi? </channel>

Shelly: GET /api/today + memory_search(query="bob recent work")
  outbound through grammy Bot #3 → bob_devpanl_bot → Bob
  "Salut Bob — hier on a livré X et Y. Toi t'es sur ZENO-42, encore en review."
```

### Deploy gate — Bob tries to ship to prod

```
Bob → bob_devpanl_bot: "deploy"
  inbound: <channel bot_label="bob" tg_user_id=999 …> deploy </channel>

Shelly recognizes deploy intent. Reads tg_user_id=999.
DEPLOY_ALLOWED_TG_USER_IDS = "5663177530" → 999 not in list.
Reply through Bob's bot: "Le deploy est verrouillé pour Franck pour l'instant.
  Je peux te draft le dispatch et lui demander, OK?"

If Bob says yes → Shelly DMs Franck through Franck's bot:
  "Bob veut deploy <branch>. OK?"
```

## Error handling

| Failure | Detection | Response |
|---|---|---|
| `/pair` token rejected by `getMe` | API returns 400 | Shelly: "ce token est invalide ou révoqué, vérifie chez @BotFather". No DB write. |
| `/pair` token already in `dev_bots` | UNIQUE constraint → 409 | Shelly: "ce bot est déjà pairé sous le label `<existing>`". Idempotent. |
| `/pair` from non-allowlisted `tg_user_id` | Allowlist check in Shelly persona | "Seul Franck peut pairer un nouveau bot pour l'instant." |
| `getUpdates` 409 conflict on bot N | grammy throws | Log, exponential backoff retry, alert via `notifyJob` to Franck's bot. Bot N keeps retrying; other bots unaffected. |
| Token revoked at Telegram (401) | grammy throws on poll | UPDATE `dev_bots.status='revoked'`, `bot.stop()`. Hot-reload tick confirms. Notify Franck. |
| Plugin process crash | systemd `shelly.service` + watchdog timer | Restart. All bots re-spawn from `dev_bots` SELECT. Conversation history is in-Claude only and is allowed to reset (existing behavior — same as today's single-bot crashes). |
| Outbound to revoked bot | grammy throws on `sendMessage` | Drop with log. Don't retry. |
| `notifyJob` push with no inbound context | Plugin sees no `bot_label` | Default to `bot_label='franck'`. |
| Two devs DM at the same instant | None — Claude processes turns serially per channel | Cross-channel turns are independent inbound events. Shared `memories` writes are append-only, no race. |

## Backward compatibility

- Existing `TELEGRAM_BOT_TOKEN` env: on first plugin boot, if `dev_bots` is empty AND env is set, seed `(token=$TELEGRAM_BOT_TOKEN, label='franck', paired_by_tg_user_id=$TELEGRAM_CHAT_ID, owner_tg_user_id=$TELEGRAM_CHAT_ID)`. Zero-touch migration. After this seed, the env var is informational only — the DB is the source of truth.
- `notifyJob()` (`src/server/alerts.js`) keeps using the `TELEGRAM_BOT_TOKEN` env to push. It targets Franck's chat, which is now also row #1 in `dev_bots`. No code change needed in v1; in v2 we can teach it to read from `dev_bots` and fan out.
- `SOUL.md`: existing sections unchanged. New "Pairing protocol" section appended.
- Dashboard: no UI change in v1 (Franck can `psql` or curl the API). v2 adds a `/dashboard/team` page.

## Testing

**Unit (`tests/server/dev-bots.test.js`):**
- POST validates token via mocked `getMe`, rejects 400/401, accepts 200.
- POST dedupes on `bot_token` UNIQUE → 409.
- DELETE flips status to revoked.
- Backward-compat seed: empty table + env present → one row inserted with label='franck'.

**Plugin (`plugins/telegram-multi/tests/multiplex.test.ts`):**
- Boot with 3 fake tokens in DB → 3 grammy Bot instances spawned, 3 separate `getUpdates` loops.
- Hot-reload: insert new row → poll cycle picks it up within one tick → new Bot spawned. Mark row revoked → Bot stopped within one tick.
- Inbound message decorated with `bot_label`, `tg_user_id`, `first_name`.
- Outbound routes through the correct grammy Bot based on inbound channel context.
- One bot crashing (mocked 401) doesn't bring down the others; row marked revoked.

**Integration (`tests/integration/multi-dev-pair.test.js`):**
- Real Postgres + mocked Telegram API (intercept `getMe`/`sendMessage`).
- Simulate `/pair` from owner → assert `dev_bots` row + new poller spawned.
- Simulate inbound from new bot → assert `owner_tg_user_id` captured.
- Simulate revoke → assert poller stopped.
- Simulate deploy attempt from non-allowlisted user → assert refusal.

**Manual smoke test (post-deploy, on hetzner-vps):**
1. SSH, `psql` insert a fake `dev_bots` row pointing at a real test bot created via @BotFather.
2. Wait 30s for hot-reload. `pgrep -af "bun server.ts"` shows the plugin process still alive (one process, not two).
3. DM the test bot → Shelly replies through it.
4. UPDATE row to status='revoked' → wait 30s → DM the test bot → no reply (logged drop).

**Explicitly skipped in v1:** load testing, encryption-at-rest, per-dev permission tiers, dashboard pairing UI.

## Migration / deploy

1. Ship the `dev_bots` table migration to services Postgres (idempotent CREATE TABLE IF NOT EXISTS).
2. Ship the `/api/dev-bots` endpoints to devpanel-api. No-op if no rows exist.
3. Ship the `telegram-multi` plugin to the agents host. Update `~/.claude/channels/telegram/.env` if needed (DB connection vars).
4. Restart Shelly via `systemctl restart shelly.service`. Backward-compat seed runs, Franck's existing bot continues working unchanged.
5. Update `.agents/shelly/SOUL.md` with the Pairing protocol section. Deploy via `scripts/deploy-agents.sh`.
6. Smoke test: Franck DMs his bot "/pair <test_token> test" → verify new bot spins up.
7. Onboard the 3 real devs.

## Open questions / v2 candidates

- **Dashboard `/team` page** — list paired bots, show last_inbound_at, revoke button. v2.
- **Digest fan-out** — morning digest goes to all paired devs, not just Franck. Probably worth doing soon, deliberately deferred to keep v1 small.
- **Dev-side revoke** — let Alice DM her own bot `/unpair` to remove herself. v2.
- **Token rotation** — currently no path to rotate a token without revoking + re-pairing. Fine for v1; if we ever need it, a `PATCH /api/dev-bots/:id/token` would do it.
- **Plugin upstreaming** — once the fork is stable, propose multi-token support back to `claude-plugins-official:telegram`. Saves us the maintenance.
