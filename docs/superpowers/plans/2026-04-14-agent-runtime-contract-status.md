# Agent Runtime Contract — Status

**Date:** 2026-04-14
**Branch:** `feat/agent-runtime-contract` (in worktree `.worktrees/agent-runtime-contract/`)
**Commits:** 23 ahead of `main`

## What's done (T01–T28)

All code, tests, docs, skills, and souls have landed. Green: `npm test` → 15 passed, 3 skipped (pg integration is gated on `TEST_PG=1`). Green: `npx vite build`.

- **Phase 1 — Infra:** vitest + pg installed, pgvector image swap, `agent_memory` migration SQL, env vars documented.
- **Phase 2 — Memory layer:** `src/server/voyage.js`, `src/server/pg.js`, `src/server/jobs-log.js`, three new MCP tools `memory_write` / `memory_search` / `memory_list`.
- **Phase 3 — Worker automation:** strict `parseResult` (+ tests), new `buildPrompt` shape, `notifyJob` plain-ASCII + debouncer, admin SSE endpoint, `src/worker/automation.js` matrix, strict wire-up in `src/worker/index.js`.
- **Phase 4 — Deploy:** `src/worker/auth.js` allowed_requesters (+ tests), `src/worker/handlers/deploy.js`, nightly cron at 03:00 Europe/Paris.
- **Phase 5 — Dashboard:** `src/dashboard/lib/events.js` SSE client, live-events pane on Queues view.
- **Phase 6 — SOULs:** 6 rewrites + new `deploy` soul + 7 PLAYBOOK companions + `shared-memory` mandatory skill.
- **Phase 7 — Smoke:** `scripts/smoke-agent-runtime.sh` written and committed.

## What remains (T29 — live smoke)

The smoke script needs three live dependencies that were not provisioned during this build:

1. **`VOYAGE_API_KEY`** in the shell env.
2. **Postgres migrated:** run
   ```bash
   docker exec -i devpanel-postgres psql -U affine -d postgres < infra/migrations/001-pgvector-init.sql
   ```
   Note: this requires restarting `devpanel-postgres` with the new `pgvector/pgvector:pg16` image first (simple `docker compose up -d --force-recreate postgres` once the image swap lands in production).
3. **Server + worker running** locally with `ADMIN_API_KEY`, `PG_PASSWORD`, and `VOYAGE_API_KEY` in env.

Then:
```bash
cd .worktrees/agent-runtime-contract
ADMIN_API_KEY=... VOYAGE_API_KEY=... PG_PASSWORD=... ./scripts/smoke-agent-runtime.sh
```

Expected: four `OK` lines (memory roundtrip, SSE publish/consume, deploy authorization rejection, notifyJob formatted).

## What's deliberately out of scope (still)

- **Spec 2 — Workflow engine** (Builder→QA chains, cycle-end audit, replan loop).
- **Spec 3 — Cybersec agent.**
- **Shelly Telegram bot commands** (`/deploy`, `/status`, digest).
- **Memory pruning / TTL enforcement.**

## Merge path

When live smoke passes, `superpowers:finishing-a-development-branch` guides integration. Most likely path: merge `feat/agent-runtime-contract` into `main` as a single merge commit with a detailed body pointing at the spec + plan + this status file.
