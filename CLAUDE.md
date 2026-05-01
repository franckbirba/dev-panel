# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

dev-panel is a plug & play bug/feature reporting system for React apps. Users report issues via a floating UI widget, PMs review tickets via CLI, and approved tickets are published as GitHub issues.

**Flow:** React DevPanel UI → Express API → SQLite storage → CLI review → GitHub Issues

## Commands

```bash
# No build step needed (pure ESM)
npm run build    # no-op

# No tests yet
npm run test     # no-op

# Run the CLI
node bin/dev-panel.js <command>

# Start the API server (default port 3030)
node bin/dev-panel.js serve

# Key CLI commands
node bin/dev-panel.js init              # Initialize project config
node bin/dev-panel.js list              # List tickets
node bin/dev-panel.js review <id>       # Show ticket details
node bin/dev-panel.js publish <id>      # Push ticket to GitHub
node bin/dev-panel.js reject <id>       # Reject a ticket
node bin/dev-panel.js sync              # Sync with GitHub
node bin/dev-panel.js stats             # Dashboard
node bin/dev-panel.js admin             # Project management (hidden command)
```

## Architecture

The package has four layers with clean separation:

- **CLI** (`bin/dev-panel.js` + `src/cli/commands/`) — Commander.js-based command router with 8 commands
- **API Server** (`src/server/index.js`, `src/server/routes.js`) — Express REST API with API key auth (`X-API-Key` header). Exports `createServer` and `startServer`
- **Database** (`src/server/db.js`) — Two-level SQLite via better-sqlite3: master `projects.db` (multi-project registry with API keys) and per-project `projectId/tickets.db` (tickets with BLOB screenshot storage)
- **React UI** (`src/react/DevPanel.jsx`) — Floating bug/feature report widget with screenshot capture. Exported via `./react` package entry point

## Key Design Decisions

- **Pure ESM** — All files use ES module imports, no CommonJS
- **Multi-project architecture** — Each project gets its own SQLite database, identified by API key
- **No external DB** — Everything is local SQLite files under a `storage/` directory
- **Screenshots stored as BLOBs** — Base64 images stored directly in SQLite, served via `/api/tickets/:id/screenshot`
- **GitHub sync is bidirectional** — Publishes tickets as issues and syncs status back when issues close

## Package Exports

- Default (`.`) → `src/server/index.js` (server functions)
- `./react` → `src/react/index.js` (DevPanel component)
- Binary: `dev-panel` CLI command

## Configuration

Project config lives in `.devpanelrc.json` (template at `templates/.devpanelrc.json`). Contains project name, server port, GitHub credentials, sync settings, and storage path.

## Deploy isolation — persistent services are off-limits on `git push`

**Rule:** a push to `main` refreshes *only* the `devpanel` container. Everything else on the services VPS — Plane, Penpot, Affine, traefik, redis, postgres, bull-board, uptime-kuma — is **persistent team infrastructure** that must survive every deploy. It holds user data (work items, design files, notes, memory). `.github/workflows/deploy.yml` reflects this: it runs `docker compose up -d --no-deps devpanel` and nothing else. Don't add `docker compose --profile plane|penpot|monitoring up -d` back into CI.

**Bootstrap / full stack rebuild** is a deliberate, manual operation run on the VPS:
```bash
ssh deploy@77.42.46.87 'cd ~/dev-panel && docker compose --profile all up -d'
```
Never trigger this from CI.

**On the VPS there must be exactly one env file.** Keep `.env.production`; delete `.env` or symlink it to `.env.production`. Docker Compose reads `.env` first for interpolation — if both exist, `.env` wins silently and drifts from `.env.production`, which is exactly how Plane's DB password kept getting baked wrong into recreated containers.

**Postgres stored password drift** is a separate recurring trap: `POSTGRES_PASSWORD` only initializes the role on the first volume write. Once the volume exists, changing the env var has no effect — the running DB still accepts only the original password. Recover with:
```bash
docker exec plane-db psql -U plane -d plane -c "ALTER USER plane WITH PASSWORD '<hex>';"
```
See memory `infra_plane_caveats.md` for the full symptom-to-fix decision tree.

## GlitchTip — error tracking bootstrap (DEVPA-168)

GlitchTip lives at `glitchtip.devpanl.dev` and feeds runtime errors into the captures inbox via the bridge endpoint at `POST /api/webhooks/glitchtip/:projectId` (DEVPA-169). Stack: `glitchtip-web` + `glitchtip-worker` + `glitchtip-migrate` + dedicated `glitchtip-db` (postgres) + dedicated `glitchtip-redis`. **Do not** reuse plane-db or devpanel's redis — Django migrations would interfere.

The compose profile `glitchtip` is opted-out of CI deploys (deploy isolation rule above). Bootstrap is **always manual**:

```bash
ssh deploy@77.42.46.87
cd ~/dev-panel
# 1. Generate secrets and add to BOTH .env and .env.production:
#    GLITCHTIP_SECRET_KEY=$(openssl rand -base64 50 | tr -d '\n')
#    GLITCHTIP_DB_PASSWORD=$(openssl rand -hex 24)
#    GLITCHTIP_BRIDGE_HMAC_SECRET=$(openssl rand -hex 32)
# 2. Confirm DNS A record glitchtip.devpanl.dev → 77.42.46.87 resolves
# 3. Bring the stack up
docker compose --profile glitchtip up -d
# 4. Wait for migrations to complete (one-shot container, exit 0)
docker compose logs -f glitchtip-migrate
# 5. Create the superuser
docker exec -it glitchtip-web ./manage.py createsuperuser
# 6. Browse to https://glitchtip.devpanl.dev (passes oauth2-proxy Google SSO),
#    log in with the superuser account, then in the UI:
#      - create Organization "devpanl-studio"
#      - Profile → Auth Tokens → generate one with scopes
#        org:admin + project:admin + project:write
#      - put the token on the agents host as GLITCHTIP_API_TOKEN for the
#        plugin auto-wiring (DEVPA-170)
# 7. Smoke-test the public ingest path with an anonymous curl that
#    targets a real test project's DSN; confirm the event appears in the UI
# 8. Add glitchtip-pgdata to the nightly pg_dump backup runbook
```

No oauth2-proxy gate on this host — GlitchTip handles auth itself (Django login, invite-only via `ENABLE_USER_REGISTRATION=False`), same convention as Plane and Affine. Putting the Google SSO middleware in front would also brick SDK ingest, since cross-domain client apps can't share the oauth cookie. (We tried two-router PathRegexp split first, but `PathRegexp` is a Traefik v3 matcher and we're on v2.11 — the rule silently failed to register and the catch-all UI router swallowed every request.)

Ingest paths (`/api/<num>/store/`, `/envelope/`, `/security/`, `/minidump/`) are public by design — auth lives in the DSN's public key, validated by GlitchTip itself.

### Bridge alert webhook — querystring auth (NOT HMAC)

The original spec assumed signed bridge webhooks. **GlitchTip's "Generic Webhook" alert recipient does NOT sign payloads** — confirmed live during DEVPA-168 bring-up. The bridge endpoint at `POST /api/webhooks/glitchtip/:projectId` therefore accepts auth via either:

1. **`x-glitchtip-signature` HMAC header** (kept for any future signed source / Sentry-style enterprise webhooks), or
2. **`?secret=<GLITCHTIP_BRIDGE_HMAC_SECRET>` querystring** — the path GlitchTip alerts actually use today.

When configuring an alert in the GlitchTip UI for any client project, set the webhook URL to:

```
https://devpanl.dev/api/webhooks/glitchtip/<devpanl-project-id>?secret=<GLITCHTIP_BRIDGE_HMAC_SECRET>
```

The URL itself is the bearer token — treat it like a capability URL (Google Docs share link, S3 presigned URL). To rotate, regenerate `GLITCHTIP_BRIDGE_HMAC_SECRET` and edit the alert URL on every wired project.

The Postgres password drift trap (above) applies to `glitchtip-db` too — `GLITCHTIP_DB_PASSWORD` only takes effect on first volume write. Rotate with `ALTER USER glitchtip WITH PASSWORD '<new>'` inside the running container.

## Shelly — the orchestration agent (READ BEFORE TOUCHING TELEGRAM)

Shelly is **not a script, not a bot framework, not `claw.js`**. She is a persistent **Claude Code CLI session** running on the agents host with the `telegram-multi` plugin (Apache-2.0 fork of `claude-plugins-official:telegram` with multi-bot support). You chat with her in Telegram; she dispatches work to other agents and reports back.

### Runtime topology

| Host | Role | What runs |
|---|---|---|
| `hetzner-vps` — 62.238.0.167 (agents node, internal 10.0.0.3) | Shelly + coding agents | `tmux -L deploy -s shelly` session → `claude --dangerously-load-development-channels server:telegram --dangerously-skip-permissions` as user `deploy`, cwd `/home/deploy/projects/dev-panel`. The `server:telegram` form points at the manually-configured `telegram` MCP server in `~/.mcp.json` (the `telegram-multi` bun process). Don't also pass `--channels server:telegram` — the parser de-dupes weirdly and Claude will subscribe twice with one entry trapped in dev:false / dev:true conflict; symptom is the pane showing "server:telegram, server:telegram" with a "server: entries need…" warning. BullMQ worker `node src/worker/index.js` pulls jobs from Redis (services node) and spawns **ephemeral** `claude -p` subprocesses per job. |
| services VPS — 77.42.46.87 (internal 10.0.0.2) | Control plane | `devpanel-api` container (Express + MCP + `notifyJob()` push notifications), Redis, Postgres, dashboard, bull-board. |

### Who polls the Telegram bot token

**Exactly one process** may call `getUpdates` for a given bot token or Telegram returns `409 Conflict` and *everyone* loses messages. That one process is **Shelly** (the tmux session on `hetzner-vps`). Do not start any other poller with the same token anywhere — no second tmux, no Docker container, no local `node claw.js`, nothing.

Push-only `sendMessage` calls (used by `notifyJob()` in `src/server/alerts.js`) are fine — they don't conflict.

With `telegram-multi`, the plugin manages N grammy `Bot` instances *inside* one Bun process. Telegram's one-poller-per-token rule still holds — there is exactly one `getUpdates` long-poll per token, just N tokens now (one per dev's paired bot, plus Franck's). Do not run a second `telegram-multi` process against the same `dev_bots` table from another host or every token will see 409 Conflict storms.

### Telegram env vars

Both `.env` and `.env.production` on services VPS must carry `TELEGRAM_BOT_TOKEN=8661116721:...` and `TELEGRAM_CHAT_ID=5663177530` (numeric, never a t.me URL). `.env` takes precedence over `.env.production` in `docker-compose`, so fix both when updating.

### Dispatch flow

1. You → Telegram → Shelly (Claude with restricted MCP tools: devpanel, plane, affine, penpot, github, pgvector, bullmq).
2. Shelly reads context via MCP, identifies work, calls `enqueue_job` on the devpanel MCP.
3. BullMQ worker (same host) pops the job, spawns `claude -p "..."` in the target project cwd with full tools.
4. Ephemeral Claude does the work and exits.
5. Shelly or the worker's `notifyJob()` reports status back to Telegram.

**Shelly does not code.** She dispatches and reports. Coding happens in the ephemeral `claude -p` subprocesses.

### Relaunching Shelly

Use `systemctl restart shelly.service` on hetzner-vps — that's the unit at `infra/shelly.service`. The `ExecStart` pins the right channel flags and PATH; do not hand-craft `tmux new-session` calls (the old runbook here did, and people kept reverting to it after each new failure mode, accumulating drift).

The unit launches `claude --dangerously-load-development-channels server:telegram --dangerously-skip-permissions` inside a tmux session. `bun` must live at `/home/deploy/.bun/bin/bun` and be on the unit's PATH — already pinned in `Environment=PATH=...` in the unit. Token + chat ID for Franck's legacy bot still come from `/home/deploy/.claude/channels/telegram/.env` (used by devpanel-api's first-boot seed); tokens for paired devs come from the shared Postgres `dev_bots` table.

Verify she's live: `ssh hetzner-vps 'pgrep -af "bun.*server.ts"'` must show one process, and `cat /home/deploy/logs/telegram-multi/health.json` must list every active dev_bots row with a timestamp <30s old. If `pgrep` is empty, the plugin failed to start. If `health.json` shows fewer keys than `dev_bots.status='active'` rows, a specific bot's polling died — check `/home/deploy/logs/telegram-multi.log` for the `polling stopped` line.

### Self-heal — `telegram-multi` is supposed to recover from 409s on its own

Each grammy `Bot` runs under a per-bot supervisor (`plugins/telegram-multi/server.ts`, `startWithSupervisor`). When `bot.start()` rejects with anything other than 401:
- It logs `polling stopped (attempt N, retry in Mms)`
- It schedules a retry via `pollRetryDelayMs(N)` — exponential backoff capped at 60s
- The row stays in `running` so `BotRegistry.diffBots` doesn't double-add

A 401 marks the row revoked and gives up. Anything else loops forever (with backoff) until polling succeeds or the row is removed from `dev_bots`.

In parallel the plugin writes `/home/deploy/logs/telegram-multi/health.json` every 15s. The systemd watchdog (`infra/shelly-watchdog.sh`) reads it: if any bot's stamp is >180s old, it restarts `shelly.service` with `reason="bot deaf: <label>(Ns)"`. This is the safety net for the failure mode the supervisor can't recover from on its own (e.g., bun process running but grammy is wedged).

The original failure that motivated this (Apr 27 19:12 UTC, fixed Apr 28): franck's bot got a 409 during a restart race, polling stopped, the row stayed in `running`, no retry, no restart, dead until the daily 4 AM cycle. The supervisor fixes the recovery. The watchdog fixes detection. The smoke test (`scripts/smoke-shelly.sh`, called from `deploy-agents.sh`) makes the next regression visible at deploy time instead of at 9 AM the next day.

Attach to observe: `ssh hetzner-vps 'su - deploy -c "tmux -L deploy attach -t shelly"'` (read-only preferable — `Ctrl-b d` to detach).

### Dead code — do not resurrect

- `claw.js` and anything in `docs/SHELLY.md` referencing OpenClaw, `claw` CLI, `node-telegram-bot-api`, or a `shelly-bot` Docker container is the **old design, abandoned**. The `/issues` /resolve /resolveall slash-command bot is not part of the current architecture. If you see a `shelly-bot` service in `docker-compose.yml` or a `bot` script in `package.json`, they are leftovers to remove.

### References (on the repo)

- `src/worker/index.js` — BullMQ worker on agents host
- `src/server/alerts.js` — `notifyJob()` push notifications
- `.agents/shelly/SOUL.md` — Shelly's persona/tool restrictions (single source of truth, included into this CLAUDE.md via `@` below)
- Memory: `shelly_bootstrap.md`, `shelly_job_decisions.md`, `infra_prod_network.md`

## Shelly's persona

Shelly's full persona, voice, tools, capture protocol and thread-tag protocol live in **`.agents/shelly/SOUL.md`** and are auto-loaded by Claude Code via the `@` include below. That file is the single source of truth — edit it, not this section.

Key rule (don't forget): **Shelly speaks like a human, not a log relay.** Reformulate events into short conversational messages with context and an option/question. Never just paste `[builder] FAILED job_id=…` — say "le builder a planté sur ZENO-42, je relance ou tu regardes le log?".

@.agents/shelly/SOUL.md

## UI catalogue — ui.devpanl.dev

Before building any UI in any studio project, check the catalogue at
https://ui.devpanl.dev (htpasswd: same credentials as bull-board / affine).
It lists:

- Shared design tokens (colors, spacing, radii, typography) under `shared/`.
- Per-project components under `devpanel/`, `zeno/`, `edms/`, `candidat/`.

Authoring rule: each project's stories live in its repo under `stories/`
and are synced to the catalogue on every push to main by the reusable
`sync-stories.yml` workflow. Full authoring conventions:
`skills/storybook-authoring.md` in the `devpanl-claude-plugin` repo.

