#!/bin/bash
# Watchdog for shelly-public.service.
#
# Public Shelly has a much smaller failure surface than internal Shelly:
#   - no Telegram bot poller (so no per-bot deafness check),
#   - no widget bridge yet (DEVPA-163 will add transport-level health),
#   - just a tmux session running `claude` with the restricted MCP config.
#
# Therefore the check reduces to: does a `claude` process exist inside the
# `shelly-public` tmux session? If not, restart shelly-public.service.
# Restart cadence is bounded by the timer (60s OnUnitActiveSec) so the
# acceptance criterion "if the process dies, the watchdog restarts it in
# under 60s" is satisfied by definition.
#
# Each restart records a one-line audit entry to
# /home/deploy/logs/shelly-public-restarts.log so we can spot crash loops
# without rifling through journalctl.
set -euo pipefail

LOG=/home/deploy/logs/shelly-public-restarts.log
mkdir -p "$(dirname "$LOG")"

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
REASON=""

# 1) tmux session must exist. If it doesn't, the unit either failed to start
#    or someone killed it — restart unconditionally.
if ! /usr/bin/tmux -L deploy has-session -t shelly-public 2>/dev/null; then
  REASON="tmux session shelly-public missing"
fi

# 2) Inside the session there must be a `claude` process for the deploy user
#    with the public MCP config in its argv. Without that, the session is a
#    bare shell and the agent is dead.
if [ -z "$REASON" ]; then
  if ! pgrep -u deploy -f "claude.*mcp-public" >/dev/null 2>&1; then
    REASON="claude process for shelly-public missing"
  fi
fi

# CRITICAL: only restart when REASON is non-empty. Falling through on a
# healthy run is the bug that bit shelly-watchdog.sh on 2026-04-28 (empty
# REASON, but logger+systemctl ran unconditionally → 65s restart loop).
if [ -z "$REASON" ]; then
  exit 0
fi

logger -t shelly-public-watchdog "$REASON — restarting shelly-public.service"
echo "$(ts) restart reason=\"$REASON\"" >> "$LOG"

if ! /usr/bin/systemctl restart shelly-public.service; then
  echo "$(ts) restart_failed reason=\"systemctl restart returned non-zero\"" >> "$LOG"
  exit 1
fi
