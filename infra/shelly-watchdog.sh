#!/bin/bash
# Restart shelly.service when the Telegram plugin is gone, has gone deaf at
# the process level (bun alive but no ESTABLISHED socket to api.telegram.org
# for >2 ticks), OR when a SPECIFIC bot has stopped polling while peers are
# still healthy (per-bot deafness — the 2026-04-27 franck-bot regression
# that the original socket-only check could not see).
#
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

# telegram-multi writes one ISO timestamp per active bot here every 15s.
# Path mirrors $TELEGRAM_MULTI_HEALTH_DIR in shelly.service. If the file is
# missing (older plugin, fresh boot, plugin crashed) we silently skip the
# per-bot check and rely on the socket heuristic — no regression.
HEALTH_FILE=/home/deploy/logs/telegram-multi/health.json
# Per-bot deafness threshold. The plugin bumps every 15s, so 180s = >10 missed
# ticks → genuinely stuck, not a normal long-poll dwell.
PER_BOT_DEAF_AFTER=180

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
REASON=""

# 1) Liveness — at least one Telegram-plugin bun process must exist.
# The legacy claude-plugins-official spawn was `bun server.ts` (bare arg);
# the current telegram-multi spawn is `bun /full/path/server.ts`. Match both.
if ! pgrep -f "bun.*server\.ts" >/dev/null 2>&1; then
  REASON="bun telegram plugin missing"
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
  else
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
fi

# 3) Per-bot deafness — at least one ESTABLISHED socket isn't enough when
# we have N>1 bots: the franck-bot 2026-04-27 regression had 3 healthy bots
# masking the dead one. Read telegram-multi's health.json and trip if any
# label is stale by more than $PER_BOT_DEAF_AFTER seconds.
if [ -z "$REASON" ] && [ -f "$HEALTH_FILE" ] && command -v jq >/dev/null 2>&1; then
  NOW=$(date -u +%s)
  # jq's fromdateiso8601 doesn't accept fractional seconds — strip ".###"
  # before parsing. The plugin writes Date.toISOString() which always has
  # ".###Z"; this filter handles both forms defensively.
  STALE_BOTS=$(jq -r --argjson now "$NOW" --argjson thresh "$PER_BOT_DEAF_AFTER" '
    def secs: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
    to_entries
    | map(select(($now - (.value | secs)) > $thresh)
          | "\(.key)(\($now - (.value | secs))s)")
    | join(",")
  ' "$HEALTH_FILE" 2>/dev/null || true)
  if [ -n "$STALE_BOTS" ]; then
    REASON="bot deaf: $STALE_BOTS"
  fi
fi

# CRITICAL: only restart when REASON is non-empty. Falling through to the
# restart block on a healthy run is exactly the bug that caused the 65s
# restart loop on 2026-04-28 — empty REASON, but logger+systemctl ran
# unconditionally because all earlier checks merely *populated* REASON
# instead of `exit 0`-ing on success.
if [ -z "$REASON" ]; then
  exit 0
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
