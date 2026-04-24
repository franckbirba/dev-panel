# dev-panel

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Control plane for a solo-with-agents studio. One repo holds a floating React widget, a captures/threads triage surface, a BullMQ-backed workflow engine that dispatches ephemeral `claude -p` jobs, a persistent orchestration agent (Shelly) in Telegram, shared pgvector memory, and the dashboard that ties it all together.

> **Status:** not a general-purpose library. This repo operates [devpanl.dev](https://devpanl.dev) and the agents behind it. The React widget is still embeddable in other apps; everything else is infrastructure-of-one.

## What lives here

| Surface | Path | Purpose |
|---|---|---|
| React widget | `src/react/DevPanel.jsx` | Floating bug/feature/capture reporter, screenshot, optional `user` prop (reporter identity) |
| Express API | `src/server/*` | Captures, threads, work-items, signals, bulk admin, SSE, MCP ingest endpoints |
| Dashboard | `src/dashboard/*` | Captures as the default landing, Today, Agents, Work items, Queues, Ops |
| Workflow engine | `src/worker/engine.js` | YAML-defined agent chains with revision/replan/exhaustion |
| BullMQ worker | `src/worker/index.js` | Spawns `claude -p` stream-json, persists events, runs automation hooks |
| Orchestration MCP | `src/mcp/server.js` | 23 tools: dispatch, list/cancel jobs, plane work items + attachments, memory, threads |
| Shelly | `.agents/shelly/SOUL.md` | Persistent Claude Code tmux session on the agents host; reads Telegram |

## Two-host topology (prod)

```
┌────────── services VPS (10.0.0.2) ──────────┐   ┌────────── agents VPS (10.0.0.3) ─────────┐
│  devpanel-api (docker)                      │   │  devpanel-worker (systemd)               │
│  devpanel-postgres  ← shared pg, pgvector   │◄──┤  shelly.service (tmux + claude CLI)      │
│  devpanel-redis     ← BullMQ queue          │   │  shelly-watchdog.timer (60s)             │
│  Plane, AFFiNE, Traefik, bull-board         │   │  shelly-daily-restart.timer (04:00 CET)  │
│  +oauth2-proxy on internal UIs              │   │  ephemeral `claude -p` per job           │
└─────────────────────────────────────────────┘   └──────────────────────────────────────────┘
```

All orchestration state (`workflow_instances`, `agent_job_log`, `agent_job_events`, `agent_memory_writes`, `memories`) lives in the shared Postgres on the services node. Worker and API hit the same pg over the private LAN — no split-brain.

## Local dev

```bash
npm install

# API + dashboard
node bin/dev-panel.js serve            # :3030
npm run dev:dashboard                  # :5173, proxies /api to :3030

# Tests (pg-backed suites spin a throwaway postgres:16-alpine container)
npx vitest run
```

Required env for the pg-backed flows: `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE`, `REDIS_HOST`, `REDIS_PORT`. See `infra/devpanel-worker.service` for the production values; docker-compose wires the same values for the container.

## React widget (the only part meant to be embedded elsewhere)

```jsx
import { DevPanel } from 'dev-panel/react';

<DevPanel
  apiUrl="https://devpanl.dev"
  apiKey="dp_your_project_key"
  user={{ id: '42', name: 'Alice', email: 'alice@example.com' }}  // optional
/>
```

`user` is forwarded as the capture's reporter; omit it for anonymous captures. The widget captures URL, user agent, viewport, timestamp, and an optional screenshot.

Standalone embed (no bundler):

```html
<script src="https://devpanl.dev/widget.js"></script>
<script>DevPanel.mount({ apiUrl: 'https://devpanl.dev', apiKey: 'dp_...' });</script>
```

## CLI

```bash
node bin/dev-panel.js <command>
```

Live commands: `serve`, `init`, `admin`, `list`, `review`, `publish`, `reject`, `sync`, `stats`, `import`, `sync-docs`, `clarify`, `workflow <dispatch|list>`. Per-command flags via `--help`.

## MCP server

Shelly and ephemeral workers talk to the devpanel MCP server (23 tools). Names:

- **Projects / tickets:** `list_projects`, `get_bugs`, `get_context`, `update_status`, `get_messages`, `post_message`, `get_project_info`
- **Dispatch + queue:** `enqueue_job`, `devpanel_workflow_dispatch`, `list_jobs`, `cancel_job`, `set_mode`, `get_mode`
- **Plane:** `plane_dispatch_work_item`, `plane_close_cycle`, `plane_list_attachments`, `plane_download_attachment`, `plane_upload_attachment`
- **Memory (pgvector):** `memory_write`, `memory_search`, `memory_list`
- **Threads / auth:** `thread_append`, `auth_deny`

Wire via `.mcp.json` — template at `infra/agents-mcp.json.template` (rendered by `scripts/deploy-agents.sh` with the right secrets + the private-LAN pg/redis hosts).

## Deploy

- **Services API:** `git push origin main` → `.github/workflows/deploy.yml` builds the image and refreshes the `devpanel` container. Only the dev-panel container is touched — Plane, Penpot, AFFiNE, Traefik, redis, postgres are persistent team infra and stay up. See `CLAUDE.md` → "Deploy isolation" for the rules.
- **Agents VPS (worker + Shelly):** `bash scripts/deploy-agents.sh` — pulls main, rewrites `.env.agent` from services secrets, reinstalls systemd units, restarts worker + shelly.

Full stack rebuild (rare, manual only): `ssh deploy@…/services 'cd ~/dev-panel && docker compose --profile all up -d'`. Never from CI.

## Services

| Service | URL |
|---|---|
| DevPanel | https://devpanl.dev |
| Plane | https://plane.devpanl.dev |
| AFFiNE | https://affine.devpanl.dev |
| Penpot | https://penpot.devpanl.dev |
| Traefik | https://traefik.devpanl.dev |
| Bull Board | https://queues.devpanl.dev |
| Storybook catalogue | https://ui.devpanl.dev |

## License

MIT © [Franck Birba](https://github.com/franckbirba)
