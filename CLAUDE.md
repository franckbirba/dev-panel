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

## Chat is the App — v0.42 architecture (2026-05-10)

Effective 2026-05-10, the canonical UI for `devpanl.dev/dashboard` is the chat-first surface in `apps/chat/` (Next 16 + assistant-ui + Vercel AI SDK 6 + remote MCP). The legacy Vite SPA at `src/dashboard/` is **frozen** and reachable as an escape hatch at `?legacy=1` until 2026-05-17, after which it gets deleted (DEVPA-208 acceptance).

**The headline rule for any future agent (Shelly included):** when something looks broken or missing in the dashboard, *don't* go editing `src/dashboard/`. The answer is almost always:
- A missing card → write a `apps/chat/components/devpanl/<X>Card.tsx` composed from shadcn primitives in `components/ui/`. Add a story under `apps/chat/stories/devpanl/`.
- A missing tool → register it in `src/mcp/server.js` (or one of the modules it imports — `runtime.js`, `plane-pages.js`, etc.). The chat picks it up automatically via the remote MCP at `https://devpanl.dev/mcp`.
- A missing render of an existing tool → wire `makeAssistantToolUI` in `apps/chat/app/assistant.tsx` to map the tool's name to a card.

**Stack:**
- `apps/chat/app/api/chat/route.ts` *(deleted)* → backend lives in `src/server/chat.js` because the deploy is a static export. The Express handler streams via `streamText` + `toUIMessageStreamResponse`, exposing the 50+ MCP tools as the AI SDK tool surface.
- `apps/chat/components/ui/` → shadcn primitives, project-agnostic. They could move to `ui.devpanl.dev` as-is.
- `apps/chat/components/devpanl/` → DevPanel composition. **The only place project-specific UI lives.** No `<style>` blocks; no inline visual `style={{}}` props (enforced by `apps/chat/scripts/check-design-rules.mjs`).
- Tokens: `apps/chat/app/globals.css` is the source of truth, mirrored from `src/dashboard/app.css` (the legacy file). Keep them in sync until the legacy SPA dies.

**Build/deploy:**
- `npm run build:chat` → `apps/chat → out/ → dist/dashboard/` (committed; the deploy workflow rsyncs from git, no CI build — see `feedback_dashboard_dist_commit.md`).
- `npm run build:dashboard-legacy` → Vite SPA into `dist/dashboard-legacy/`.
- `npm run build` runs both + the widget.
- The deploy workflow (`./.github/workflows/deploy.yml`) rsyncs `dist/dashboard/**`, `dist/dashboard-legacy/**`, `dist/widget.js`. Don't add CI build steps.

**Provider routing (LLM choice for the chat itself, not for ephemeral agents):**
- `LLM_PROVIDER` + `LLM_MODEL` on `devpanel-api` controls the default. Today: `deepinfra` + `Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo`.
- Dropdown in the chat header (`apps/chat/components/devpanl/ProviderSwitcher.tsx`) lets the user override per-session via `localStorage`. Backend wiring of the user's choice is DEVPA-206 follow-up.
- This is **independent** of `DRIVER_DEFAULT` / `DRIVER_<AGENT>` which govern the BullMQ workers.

**One brain, two surfaces:** the dashboard chat is *another client of Shelly's persistent tmux session*, not a separate Claude. Submitting a message → POST `/api/threads/<subject>/<id>/messages` → Shelly's inbound web source consumes it → her reply broadcasts via socket.io to all subscribers of that thread. The Telegram + dashboard surfaces show the same conversation. (DEVPA-204 backend — partial; visible UI ships in v0.42, full Shelly bridge is the next push.)

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

**Plane API rate limits — two layers, one knob.** Plane has *two* throttles: (1) the per-API-key `ApiKeyRateThrottle` in `/code/plane/api/rate_limit.py` (the one our agents hit — emits `error_code:5900 RATE_LIMIT_EXCEEDED`) defaulting to `60/minute`, controlled by env `API_KEY_RATE_LIMIT`; and (2) the DRF-wide `AnonRateThrottle` in `/code/plane/settings/common.py` defaulting to `30/minute`, with no env knob. With 5 devs × parallel `claude -p` agents × ~15 calls per work-item bootstrap, both saturate within seconds. The fix:

- Set `API_KEY_RATE_LIMIT=10000/minute` on the `plane-api` service (already wired in `docker-compose.yml`). This is the actual fix — covers all authenticated MCP/agent traffic.
- Mount `./infra/plane/common.py:/code/plane/settings/common.py:ro` on `plane-api` as belt-and-braces for paths that fall through to the anon throttle (also bumped to `10000/minute`).

Verify after recreate:
```bash
docker exec -e DJANGO_SETTINGS_MODULE=plane.settings.production plane-api \
  python -c "from django.conf import settings; print(settings.REST_FRAMEWORK['DEFAULT_THROTTLE_RATES'])"
docker exec plane-api env | grep API_KEY_RATE_LIMIT
```

To upgrade Plane: `docker exec plane-api cat /code/plane/settings/common.py > infra/plane/common.py`, re-apply the bumped rates, commit.

**Network landmine — `plane-api` recreate drops `devpanel_net`.** Recreating `plane-api` via compose attaches it only to `dev-panel_devpanel_net` (project-prefixed); but `plane-db`/`plane-redis` live on `devpanel_net` (no prefix), so the new container fails to resolve `plane-db` → 502 loop. Fix after every recreate:
```bash
docker network connect devpanel_net plane-api
```
This is the same network-split symptom documented in `infra_plane_caveats.md`. The proper fix would be marking `devpanel_net` as `external: true` in `docker-compose.yml`, but that's a bigger change touching every service — for now, the manual reconnect after a `plane-api` recreate is the working runbook.

**The `projects` table lives services-side only.** It is the single source of truth for `plane_project_id`, `local_path`, `default_branch`, `api_key`, and team routing. The `devpanel-api` container mounts the SQLite file from the `devpanel-storage` volume on the services VPS. The agents host has its own checkout of this repo (`/home/deploy/projects/dev-panel`) but its `storage/projects.db` is **empty** — never trust it. Any code that needs to resolve a Plane project_id to a local checkout path **must** go through `GET /api/admin/projects/by-plane-id/:plane_project_id` (admin-auth) on services. The MCP `devpanel-mcp` and the worker's `enqueueWorkflowStart` already do this when `API_BASE` + `ADMIN_API_KEY` are set. Don't add new code that reads `projects.db` directly from the agents host. (DEVPA-180)

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

### Read/resolve from agents — `glitchtip_get_issue` / `glitchtip_resolve_issue`

The bridge above goes one direction (GlitchTip → captures). For the other direction — Shelly triaging an issue by id, or an ephemeral agent closing an issue after a fix has merged — the devpanel-mcp exposes two tools backed by the Sentry-compatible API: `glitchtip_get_issue({ org_slug, issue_id })` returns `{ title, culprit, level, status, last_event: { message, exception, stack, breadcrumbs, tags } }`, and `glitchtip_resolve_issue({ org_slug, issue_id })` PUTs `status=resolved`. Auth is `Bearer $GLITCHTIP_API_TOKEN` (the same UI-generated token from bootstrap §6, with `org:admin + project:admin + project:write`); base URL is `$GLITCHTIP_BASE_URL` (defaults to `https://glitchtip.devpanl.dev`). Both env vars are wired through `infra/agents-mcp.json.template` → `~/.mcp.json` on the agents host. 401/403 surface explicitly so a rotated/revoked token never silently returns an empty payload.

## Remote MCP — `https://devpanl.dev/mcp`

The same MCP server that runs in stdio for Shelly (`src/mcp/server.js`, 23+ tools — dispatch, plane, memory, threads, captures, glitchtip, dev-bots, attachments) is also exposed over HTTP at `https://devpanl.dev/mcp` so any teammate's local Claude Code / Claude Desktop can hit prod without cloning this repo.

**Auth.** `Authorization: Bearer <ADMIN_API_KEY>`. The traefik router for `/mcp` is **deliberately NOT gated by `oauth-google@docker`** — Bearer clients can't satisfy Google SSO, and the SPA catch-all router would 307 them to `auth.devpanl.dev` (symptom: 500 / login redirect from Claude). Auth is enforced inside `src/server/mcp-http.js`. Skipping the SSO middleware is the *whole point* of this router; if you ever add `oauth-google@docker` to it, Bearer auth breaks.

**Wiring (already in `docker-compose.yml`):**
- `devpanel-api` env: `ENABLE_MCP_HTTP=true`. Without this, the transport is not mounted (`src/server/index.js` checks the flag).
- `devpanel-api` traefik labels: `traefik.http.routers.devpanel-mcp.rule=Host(devpanl.dev) && PathPrefix(/mcp)`, priority `250` (beats SPA catch-all at `100`), no middleware.
- `MCP_NO_AUTOSTART=1` is set in-process before importing `src/mcp/server.js` so its stdio bootstrap doesn't try to colonize the Express stdin/stdout.

**Client config — easiest path is the Claude Code CLI:**
```bash
# Replace <token> with the studio's ADMIN_API_KEY. Once added, restart
# Claude Code so it re-runs MCP discovery; tools surface as
# `mcp__devpanel-prod__<tool_name>`.
#
# `--scope user` is intentional: this is studio-wide, you want it visible
# from every project. Without `--scope user`, the entry lands in the
# CURRENT project only (default scope is `local`), and the next time you
# `cd` into a different repo it disappears — exactly the trap that kept
# the entry hidden for months in DEVPA-211.
claude mcp add --transport http --scope user devpanel-prod https://devpanl.dev/mcp \
  --header "Authorization: Bearer <token>"
```

**Or the JSON-form** (each dev's `~/.claude.json` under the top-level `"mcpServers"` key for user scope — NOT under a project block, see scope warning above):
```json
{
  "mcpServers": {
    "devpanel-prod": {
      "type": "http",
      "url": "https://devpanl.dev/mcp",
      "headers": { "Authorization": "Bearer ${ADMIN_API_KEY}" }
    }
  }
}
```
The CLAUDE.md historically said `"type": "streamable-http"` — that was the on-the-wire transport name. The CLI / config field is just `"http"`.

For now we share `ADMIN_API_KEY` — single token. Per-dev tokens (revocable) are a follow-up; track with `dev_bots`-style rotation if it becomes an issue.

**Verify it's wired.** Run:
```bash
claude mcp list 2>&1 | grep -E "devpanel-prod|^plane"
```
You should see `devpanel-prod: ... ✓ Connected`. If you only see `plane: uvx ... plane-mcp-server` (the upstream PyPI shim), the devpanel-prod entry is missing — re-run the `claude mcp add` line above. (DEVPA-211 root cause: the entry was undocumented for years; devs only saw upstream `plane` tools and missed the studio-flavored ones — `plane_create_page`, `memory_search`, `subject_map`, `thread_append`, `auto_decision_log`, etc.)

**Drop the upstream `plane: uvx plane-mcp-server` entry once devpanel-prod is verified** — we shadow all of its useful tools and the upstream's `plane_*` names collide with ours, so leaving both creates duplicate-tool noise in `tools/list`.

**Smoke-test from a shell.** From any host with `ADMIN_API_KEY` in env:
```bash
curl -sS -X POST https://devpanl.dev/mcp \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 500
```
Expect a JSON-RPC envelope listing tools. A 401 means the Bearer token is wrong. A 307 to `auth.devpanl.dev` means traefik is routing through SSO — check the priority on `devpanel-mcp` vs. `devpanel-spa`.

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

1. You → Telegram → Shelly (Claude with restricted MCP tools: devpanel, plane, github, affine-zeno, affine-devpanl, affine-edms, pgvector, bullmq, playwright).
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

## Cheap-tier harness — goose × Qwen3-Coder via DeepInfra (Phase A, 2026-05-08)

Anthropic Max-20x is ~220k tokens / 5h; the agents fleet runs ~1M tokens / 5h. Routine work (builder, designer, pm, predicate-only merge-coordinator) routes to **goose** (Block, MCP-native CLI) driving **Qwen3-Coder-480B-A35B-Instruct** via DeepInfra's OpenAI-compat endpoint. Hard work (reviewer, qa, architect, deploy, anything that already retreated) stays on Claude. Plan: `docs/superpowers/plans/2026-05-08-agent-runtime-multi-harness.md`.

The gate is `src/worker/goose-driver.js#shouldUseGoose(agentRole)`, called from `spawnAgent` in `src/worker/index.js`. Resolution order:

1. `FORCE_TIER=opus` → always Claude (kill switch).
2. `DRIVER_<AGENT>=goose` (e.g. `DRIVER_BUILDER=goose`) → goose.
3. `DRIVER_<AGENT>=claude` → Claude (per-role override).
4. `DRIVER_DEFAULT=goose` → goose for everything not explicitly pinned.
5. Otherwise → Claude.

Required env on the agents host (services-side `.env.production`, propagated to the worker):

```
DEEPINFRA_API_KEY=<key>
GOOSE_PROVIDER=openai
GOOSE_BASE_URL=https://api.deepinfra.com/v1/openai
GOOSE_MODEL=Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo
OPENAI_API_KEY=${DEEPINFRA_API_KEY}    # goose's openai provider reads OPENAI_API_KEY
GOOSE_MODE=auto                         # auto-approve tool calls; without this the worker hangs on prompts
DRIVER_BUILDER=goose                    # canary role
```

**Kill switch:** to revert any role instantly, set `DRIVER_<AGENT>=claude` on the worker and bounce systemd. Or `FORCE_TIER=opus` for a global revert. Either takes effect on the next dispatched job — running jobs finish on their original harness.

**Bootstrap (one-time, manual on agents host):**

```bash
ssh hetzner-vps
sudo -u deploy -H bash <<'EOS'
curl -fsSL https://github.com/block/goose/releases/latest/download/goose-installer.sh | bash
~/.local/bin/goose --version

# Smoke against DeepInfra (must emit a tool call and exit 0):
GOOSE_PROVIDER=openai \
  GOOSE_BASE_URL=https://api.deepinfra.com/v1/openai \
  OPENAI_API_KEY=$DEEPINFRA_API_KEY \
  GOOSE_MODEL=Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo \
  GOOSE_MODE=auto \
  ~/.local/bin/goose run --no-session -t "list 3 files in this dir using a tool, no prose"
EOS
```

If the smoke fails (missing `goose` binary, auth error, no tool call), do **not** flip `DRIVER_BUILDER=goose` — investigate first. Pass condition is the only signal Track A3 is green.

**Cost ceiling:** track DeepInfra spend daily on the dashboard once Phase B B4 ships. Until then, monitor manually via DeepInfra's billing UI; pause the canary if daily spend exceeds $5.

## Quota fallback — Shelly + ephemerals on Pi/Qwen3 (one switch)

When Claude Max quota is exhausted, the studio doesn't stop — Shelly herself, plus every ephemeral builder/reviewer/etc., flips to Pi/Qwen3 via DeepInfra in one shot. Reverse with the same script when the quota resets.

```bash
# On the agents host (or via ssh):
ssh hetzner-vps 'sudo /home/deploy/bin/shelly-switch.sh pi'      # → Pi/Qwen3
ssh hetzner-vps 'sudo /home/deploy/bin/shelly-switch.sh claude'  # → Claude
ssh hetzner-vps 'sudo /home/deploy/bin/shelly-switch.sh status'  # which mode now?
```

**What flips together** (atomic, in this order):
1. `shelly.service` ↔ `shelly-pi.service` — orchestration agent. They're systemd `Conflicts=` so both can never run at once.
2. `/home/deploy/.driver-default` rewritten with `DRIVER_DEFAULT=pi` (or `claude`). The worker's unit reads it via `EnvironmentFile=-`.
3. `devpanel-worker.service` bounced so the next dispatched job picks up the new `DRIVER_DEFAULT`. Already-running jobs finish on their original harness — same kill-switch semantics as `FORCE_TIER=opus`.

**Per-role overrides still win.** If you set `DRIVER_REVIEWER=claude` because reviewers must stay on Opus regardless of quota mode, that override beats `DRIVER_DEFAULT=pi`. Same routing as today (see `shouldUsePi` / `shouldUseGoose` etc).

**Why Pi-Shelly works at all** — Pi 0.74 ships zero MCP support out of the box (their docs say so). We bridge the gap with three vendored Pi extensions in `infra/pi-extensions/`:

- **`mcp-bridge`** — spawns every server in `PI_MCP_CONFIG` over stdio (using `@modelcontextprotocol/sdk`) and re-exposes their tools as `mcp__<server>__<tool>`. Same naming Claude Code uses, so SOUL.md prompts (`memory_search`, `plane_dispatch_work_item`, etc.) work identically across both harnesses. Loaded by **all** pi runs (Shelly + ephemerals).
- **`telegram-out`** — Pi-Shelly only. Outbound Telegram tools (`reply` / `react` / `edit_message` / `download_attachment`) backed by Telegram's HTTP Bot API + a `dev_bots` Postgres lookup. Why a separate extension instead of going through the bridge: Pi-Shelly's loop owns a long-lived `telegram-multi` poller (Telegram's one-poller-per-token rule), so the bridge cannot also spawn one — splitting outbound to HTTP avoids the 409 Conflict.
- **`github`** + **`loop-guard`** — pre-existing, unchanged.

**MCP config files** (rendered by `scripts/deploy-agents.sh`):

- `~/.mcp.json` — full set including `telegram`. Used by **Claude-Shelly** only.
- `~/.mcp-worker.json` — full set minus `telegram`. Used by **ephemeral workers** (Claude or Pi).
- `~/.mcp-shelly-pi.json` — full set minus `telegram`. Used by **Pi-Shelly's per-message bridge runs**.

**Pi-Shelly runtime** (`scripts/shelly-pi-loop.js`):

1. Owns a long-lived `bun telegram-multi/server.ts` child (sole poller, writes inbound to `shelly_transcript`).
2. Tails `shelly_transcript` for new `direction='in'` rows from a stored bookmark.
3. For each new row, spawns `pi -p "<channel ...>...</channel>" --extension mcp-bridge --extension telegram-out --extension github --extension loop-guard --provider deepinfra --model Qwen3-Coder-480B-A35B-Instruct --append-system-prompt $(cat .agents/shelly/SOUL.md)` with `PI_MCP_CONFIG=~/.mcp-shelly-pi.json`.
4. Pi processes the message, calls MCP tools (full studio surface) + `telegram-out` for the reply, exits.
5. Loop.

One-shot-per-message instead of a persistent REPL — no in-memory conversation context, but `transcript_replay_recent` MCP tool covers the recall path. SOUL.md already documents this pattern in the "Transcript verbatim" section, so Pi-Shelly behaves like Claude-Shelly after a fresh restart (which she does daily via `shelly-daily-restart.timer` regardless).

**Known limitation — `shelly-watchdog.timer` is mode-blind.** It currently restarts `shelly.service` on detected staleness. When in Pi mode, restart `shelly-pi.service` manually if it goes deaf. Making the watchdog mode-aware is a follow-up.

**When you DON'T need to flip:** if only ephemerals are tight on quota, set `DRIVER_BUILDER=pi` (or `DRIVER_DEFAULT=pi` directly in the worker env) and leave Claude-Shelly running — she's tool-routing, not coding, and uses far less context per turn than a builder does. Full flip is for "Claude account is hard-locked" days.

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

