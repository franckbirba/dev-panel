#!/bin/bash
# Restart shelly.service when the Telegram plugin is gone OR has gone deaf
# (bun alive but no ESTABLISHED socket to api.telegram.org for >2 ticks).
# Outer `claude` can stay up while bun silently exits — Restart=on-failure
# alone wouldn't catch this. See dev-panel/CLAUDE.md.
#
# Each restart records a one-line audit entry to /home/deploy/logs/shelly-restarts.log
# so we can see frequency / clustering without rifling through journalctl.
set -euo pipefail

LOG=/home/deploy/logs/shelly-restarts.log
mkdir -p "$(dirname "$LOG")"

# tmpfs stamp — clears at boot so we don't act on pre-reboot state.
STAMP_DIR=/run/shelly-watchdog
STAMP=$STAMP_DIR/last-telegram-ok
mkdir -p "$STAMP_DIR"

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
REASON=""

# 1) Liveness — bun process must exist.
if ! pgrep -af "bun server.ts" >/dev/null 2>&1; then
  REASON="bun server.ts missing"
fi

# 2) Telegram reachability — at least one ESTABLISHED socket from a bun proc
# to a Telegram DC IP. DCs live in 149.154.160.0/20 (IPv4) and 2001:67c:4e8::/48
# (IPv6); matching the prefix `149.154.16` covers DC1-5 and the IPv6 prefix
# covers all current DCs. Two-tick grace: a transient drop won't trip; only
# a sustained one (>120s) will, since the timer fires every 60s.
if [ -z "$REASON" ]; then
  HAS_TG_SOCKET=0
  while read -r pid; do
    [ -z "$pid" ] && continue
    if /usr/bin/lsof -p "$pid" -nP 2>/dev/null | \
       grep -E "ESTABLISHED" | \
       grep -Eq "(149\.154\.1[0-9]+\.|\[2001:67c:4e8:)"; then
      HAS_TG_SOCKET=1
      break
    fi
  done < <(pgrep -f "bun.*server\.ts")

  if [ "$HAS_TG_SOCKET" -eq 1 ]; then
    touch "$STAMP"
    exit 0
  fi

  # No socket right now. Check how long it's been bad.
  if [ ! -f "$STAMP" ]; then
    touch "$STAMP"
    # First time we notice — give it a tick to recover.
    exit 0
  fi
  AGE=$(( $(date -u +%s) - $(stat -c %Y "$STAMP") ))
  if [ "$AGE" -lt 120 ]; then
    # Still within grace window.
    exit 0
  fi
  REASON="no Telegram socket for ${AGE}s"
fi

logger -t shelly-watchdog "$REASON — restarting shelly.service"
echo "$(ts) restart reason=\"$REASON\"" >> "$LOG"

if ! /usr/bin/systemctl restart shelly.service; then
  echo "$(ts) restart_failed reason=\"systemctl restart returned non-zero\"" >> "$LOG"
  exit 1
fi

# Reset the Telegram-socket stamp so the next tick gives the fresh bun procs
# a full 120s to establish their long-poll before tripping again.
rm -f "$STAMP"

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
