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

## Shelly — the orchestration agent (READ BEFORE TOUCHING TELEGRAM)

Shelly is **not a script, not a bot framework, not `claw.js`**. She is a persistent **Claude Code CLI session** running on the agents host with the official Telegram channel plugin. You chat with her in Telegram; she dispatches work to other agents and reports back.

### Runtime topology

| Host | Role | What runs |
|---|---|---|
| `hetzner-vps` — 62.238.0.167 (agents node, internal 10.0.0.3) | Shelly + coding agents | `tmux -L deploy -s shelly` session → `claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions` as user `deploy`, cwd `/home/deploy/projects/dev-panel`. BullMQ worker `node src/worker/index.js` pulls jobs from Redis (services node) and spawns **ephemeral** `claude -p` subprocesses per job. |
| services VPS — 77.42.46.87 (internal 10.0.0.2) | Control plane | `devpanel-api` container (Express + MCP + `notifyJob()` push notifications), Redis, Postgres, dashboard, bull-board. |

### Who polls the Telegram bot token

**Exactly one process** may call `getUpdates` for a given bot token or Telegram returns `409 Conflict` and *everyone* loses messages. That one process is **Shelly** (the tmux session on `hetzner-vps`). Do not start any other poller with the same token anywhere — no second tmux, no Docker container, no local `node claw.js`, nothing.

Push-only `sendMessage` calls (used by `notifyJob()` in `src/server/alerts.js`) are fine — they don't conflict.

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

```bash
ssh hetzner-vps 'su - deploy -c "cd /home/deploy/projects/dev-panel && \
  tmux -L deploy new-session -d -s shelly \
    \"TELEGRAM_BOT_TOKEN=<token> TELEGRAM_CHAT_ID=<chat> \
     claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions\""'
```

Attach to observe: `ssh hetzner-vps 'su - deploy -c "tmux -L deploy attach -t shelly"'` (read-only preferable).

### Dead code — do not resurrect

- `claw.js` and anything in `docs/SHELLY.md` referencing OpenClaw, `claw` CLI, `node-telegram-bot-api`, or a `shelly-bot` Docker container is the **old design, abandoned**. The `/issues` /resolve /resolveall slash-command bot is not part of the current architecture. If you see a `shelly-bot` service in `docker-compose.yml` or a `bot` script in `package.json`, they are leftovers to remove.

### References (on the repo)

- `src/worker/index.js` — BullMQ worker on agents host
- `src/server/alerts.js` — `notifyJob()` push notifications
- `.agents/shelly/SOUL.md` — Shelly's persona/tool restrictions (if present)
- Memory: `shelly_bootstrap.md`, `shelly_job_decisions.md`, `infra_prod_network.md`

