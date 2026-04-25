# telegram-multi

Multi-tenant Telegram channel for Claude Code. Apache-2.0 fork of
`claude-plugins-official:telegram` v0.0.6.

Polls one grammy `Bot` per active row in the shared Postgres `dev_bots`
table. Hot-reloads every 30s (no plugin restart on pair/revoke).

## Env (read from `~/.claude/channels/telegram/.env`)

- `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE` — the
  shared `agent_memory` Postgres on the services VPS (10.0.0.2:5432).
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — optional, only used by
  devpanel-api's first-boot seed. The plugin itself reads tokens from `dev_bots`.

## Rules

- Exactly one process at a time per token (Telegram's `getUpdates` rule).
  This plugin enforces it across all bots it manages because they're all
  inside one Bun process.
- If you run a second telegram-multi pointing at the same Postgres on a
  different host, both will try to poll every token → 409 Conflict storms.
  Don't do that.
