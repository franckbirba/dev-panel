#!/bin/bash
# Restart shelly.service when the Telegram plugin (bun server.ts) is gone.
# Outer `claude` can stay up while bun silently exits — Restart=on-failure
# alone wouldn't catch this. See dev-panel/CLAUDE.md.
#
# Each restart records a one-line audit entry to /home/deploy/logs/shelly-restarts.log
# so we can see frequency / clustering without rifling through journalctl.
set -euo pipefail

LOG=/home/deploy/logs/shelly-restarts.log
mkdir -p "$(dirname "$LOG")"

if pgrep -af "bun server.ts" >/dev/null 2>&1; then
  exit 0
fi

REASON="bun server.ts missing"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

logger -t shelly-watchdog "$REASON — restarting shelly.service"
echo "$(ts) restart reason=\"$REASON\"" >> "$LOG"

if ! /usr/bin/systemctl restart shelly.service; then
  echo "$(ts) restart_failed reason=\"systemctl restart returned non-zero\"" >> "$LOG"
  exit 1
fi

# Telegram ping is best-effort. Keep the chat readable: omit when this is the
# 4th-or-later restart in the past 5 minutes (clearly a crash loop, spam-pinging
# Franck makes it worse not better).
RECENT=$(awk -v cutoff="$(date -u -d '5 minutes ago' +%s 2>/dev/null || date -u -v-5M +%s)" '
  {
    cmd = "date -u -d \"" $1 "\" +%s 2>/dev/null"
    cmd | getline t
    close(cmd)
    if (t >= cutoff) c++
  }
  END { print c+0 }
' "$LOG")

if [ -f /home/deploy/.claude/channels/telegram/.env ]; then
  # shellcheck disable=SC1091
  set -a; . /home/deploy/.claude/channels/telegram/.env; set +a
fi
CHAT_ID="${TELEGRAM_CHAT_ID:-5663177530}"
if [ "${RECENT:-0}" -lt 4 ] && [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${CHAT_ID}" ]; then
  /usr/bin/curl -sS -o /dev/null --max-time 5 \
    -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=shelly-watchdog: restarted Shelly (${REASON})" || true
fi
