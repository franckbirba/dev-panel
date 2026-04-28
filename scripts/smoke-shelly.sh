#!/bin/bash
# scripts/smoke-shelly.sh — verify telegram-multi is actually polling all bots.
#
# Run on the agents host (`hetzner-vps`) as user `deploy` after a deploy or
# any time you suspect Shelly is half-deaf. Idempotent. No side effects on
# Telegram beyond an optional best-effort `[smoke]` ping to Franck.
#
# Checks:
#   1) bun process for telegram-multi exists
#   2) /home/deploy/logs/telegram-multi/health.json exists and is fresh
#   3) every active row in dev_bots has a fresh entry in health.json
#   4) every bot token still passes getMe (catches revoked tokens before
#      they show up as silent 401 in the polling supervisor)
#
# Exits 0 if everything is green, non-zero with an explicit per-bot reason
# otherwise. Designed to be the last step of scripts/deploy-agents.sh — a
# failed smoke aborts the deploy.

set -uo pipefail

HEALTH_FILE=${TELEGRAM_MULTI_HEALTH_DIR:-/home/deploy/logs/telegram-multi}/health.json
FRESH_THRESHOLD=${SMOKE_FRESH_THRESHOLD:-60}  # seconds

# Postgres connection — same vars the worker / shelly use.
PG_HOST=${PG_HOST:-10.0.0.2}
PG_PORT=${PG_PORT:-5432}
PG_USER=${PG_USER:-affine}
PG_DATABASE=${PG_DATABASE:-agent_memory}
# PG_PASSWORD: prefer real env, else lift from .env.agent (Shelly's secrets
# bundle written by scripts/deploy-agents.sh).
if [ -z "${PG_PASSWORD:-}" ] && [ -f /home/deploy/projects/dev-panel/.env.agent ]; then
  PG_PASSWORD=$(grep '^PG_PASSWORD=' /home/deploy/projects/dev-panel/.env.agent | head -1 | cut -d= -f2-)
fi

errors=()
fail() { errors+=("$*"); }

# 1) Bun process check
if ! pgrep -f "bun.*server\.ts" >/dev/null 2>&1; then
  fail "bun telegram-multi process missing"
fi

# 2) health.json freshness
if [ ! -f "$HEALTH_FILE" ]; then
  fail "health file missing: $HEALTH_FILE"
else
  age=$(( $(date -u +%s) - $(stat -c %Y "$HEALTH_FILE") ))
  if [ "$age" -gt "$FRESH_THRESHOLD" ]; then
    fail "health file stale: ${age}s old (threshold ${FRESH_THRESHOLD}s)"
  fi
fi

# 3+4) Enumerate bots from dev_bots and cross-check token validity.
# Hit Postgres over the LAN via the `pg` node module (already a worker dep,
# so no fresh install needed). Avoids a postgresql-client apt dep on the
# agents host.
PROJECT_ROOT=${PROJECT_ROOT:-/home/deploy/projects/dev-panel}
bots_csv=""
if [ -n "${PG_PASSWORD:-}" ] && [ -d "$PROJECT_ROOT/node_modules/pg" ]; then
  bots_csv=$(cd "$PROJECT_ROOT" && PG_PASSWORD="$PG_PASSWORD" \
    PG_HOST="$PG_HOST" PG_PORT="$PG_PORT" PG_USER="$PG_USER" PG_DATABASE="$PG_DATABASE" \
    node -e "
      const {Client} = require('pg');
      const c = new Client({
        host: process.env.PG_HOST, port: +process.env.PG_PORT,
        user: process.env.PG_USER, password: process.env.PG_PASSWORD,
        database: process.env.PG_DATABASE
      });
      c.connect()
        .then(() => c.query(\"SELECT bot_label, bot_token FROM dev_bots WHERE status='active' ORDER BY id\"))
        .then(r => { r.rows.forEach(x => console.log(x.bot_label + '|' + x.bot_token)); return c.end(); })
        .catch(e => { console.error(e.message); process.exit(1); });
    " 2>&1) || fail "node pg query against dev_bots failed: $bots_csv"
else
  fail "PG_PASSWORD missing or node_modules/pg not installed — cannot enumerate dev_bots"
fi

if [ -n "$bots_csv" ]; then
  while IFS='|' read -r label token; do
    [ -z "$label" ] && continue

    # Token validity (getMe).
    me=$(curl -sS --max-time 5 \
      "https://api.telegram.org/bot${token}/getMe" 2>/dev/null) || true
    if ! echo "$me" | grep -q '"ok":true'; then
      fail "bot ${label}: getMe failed (token revoked?)"
      continue
    fi

    # Heartbeat freshness in health.json.
    if [ -f "$HEALTH_FILE" ] && command -v jq >/dev/null 2>&1; then
      stamp=$(jq -r --arg k "$label" '.[$k] // empty' "$HEALTH_FILE" 2>/dev/null)
      if [ -z "$stamp" ]; then
        fail "bot ${label}: not in health.json (not polling)"
      else
        # Strip fractional seconds for fromdateiso8601.
        bot_age=$(jq -r --arg k "$label" --argjson now "$(date -u +%s)" '
          def secs: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
          $now - (.[$k] | secs)
        ' "$HEALTH_FILE" 2>/dev/null || echo "?")
        if [ "$bot_age" != "?" ] && [ "$bot_age" -gt "$FRESH_THRESHOLD" ]; then
          fail "bot ${label}: health stale ${bot_age}s"
        fi
      fi
    fi
  done <<< "$bots_csv"
fi

if [ ${#errors[@]} -eq 0 ]; then
  total=$(echo "$bots_csv" | grep -c '|' || echo 0)
  echo "smoke OK: ${total}/${total} bots polling, health fresh"

  # Best-effort Telegram ping to Franck. Non-fatal if it fails — the smoke
  # itself passed, the chat ping is just a courtesy.
  if [ -f /home/deploy/.claude/channels/telegram/.env ]; then
    # shellcheck disable=SC1091
    set -a; . /home/deploy/.claude/channels/telegram/.env; set +a
  fi
  CHAT_ID="${TELEGRAM_CHAT_ID:-5663177530}"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "$CHAT_ID" ]; then
    curl -sS -o /dev/null --max-time 5 \
      -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${CHAT_ID}" \
      --data-urlencode "text=[smoke] ${total}/${total} bots polling" || true
  fi
  exit 0
fi

echo "smoke FAILED:"
for e in "${errors[@]}"; do echo "  - $e"; done
exit 1
