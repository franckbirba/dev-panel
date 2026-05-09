#!/bin/bash
# scripts/shelly-switch.sh — flip Shelly + ephemeral builders between
# Claude Code and Pi/Qwen3 in one shot. Used when Claude Max quota is
# exhausted (or restored) so the studio keeps moving.
#
# What flips together:
#   - shelly.service        ↔  shelly-pi.service     (orchestration agent)
#   - DRIVER_DEFAULT=claude  ↔  DRIVER_DEFAULT=pi    (ephemeral builders)
#
# The `DRIVER_DEFAULT` knob is read from /home/deploy/.driver-default by
# devpanel-worker.service via EnvironmentFile. After flipping, the worker
# is bounced so the next dispatched job picks up the new default. Already-
# running jobs finish on their original harness — see CLAUDE.md "Cheap-tier
# harness" section, the FORCE_TIER kill switch story applies here.
#
# Usage:
#   shelly-switch.sh pi       — switch to Pi/Qwen3 (use when Claude quota hit)
#   shelly-switch.sh claude   — switch back to Claude Code
#   shelly-switch.sh status   — print the current mode
#
# Idempotent: re-running with the same mode is a no-op (well, it still
# bounces the worker — defensible since you usually rerun because something
# went wrong).
#
# Must run as root or via sudo (systemctl + writing to /home/deploy/).

set -euo pipefail

DRIVER_FILE=/home/deploy/.driver-default
SHELLY_CLAUDE=shelly.service
SHELLY_PI=shelly-pi.service
WORKER=devpanel-worker.service

usage() {
  echo "Usage: $0 {pi|claude|status}" >&2
  exit 2
}

current_mode() {
  if systemctl is-active --quiet "$SHELLY_PI"; then
    echo pi
  elif systemctl is-active --quiet "$SHELLY_CLAUDE"; then
    echo claude
  else
    echo none
  fi
}

unit_state() {
  local unit=$1
  local active enabled
  active=$(systemctl is-active "$unit" 2>/dev/null || true)
  enabled=$(systemctl is-enabled "$unit" 2>/dev/null || echo unknown)
  if [ -L "${ETC_SYSTEMD}/${unit}" ] && [ "$(readlink "${ETC_SYSTEMD}/${unit}")" = "/dev/null" ]; then
    enabled="masked"
  fi
  echo "${active} (${enabled})"
}

print_status() {
  local mode
  mode=$(current_mode)
  echo "Shelly mode:        $mode"
  echo "shelly.service:     $(unit_state "$SHELLY_CLAUDE")"
  echo "shelly-pi.service:  $(unit_state "$SHELLY_PI")"
  echo "DRIVER_DEFAULT:     $(grep -E '^DRIVER_DEFAULT' "$DRIVER_FILE" 2>/dev/null || echo '(unset)')"
  echo "$WORKER:            $(systemctl is-active "$WORKER" 2>/dev/null || echo inactive)"
}

write_driver_default() {
  local mode=$1
  # EnvironmentFile= format: KEY=VALUE per line, no quoting needed for bare values.
  cat > "$DRIVER_FILE" <<EOF
# Managed by scripts/shelly-switch.sh — do not edit by hand.
# The devpanel-worker.service unit reads this via EnvironmentFile.
DRIVER_DEFAULT=$mode
EOF
  chown deploy:deploy "$DRIVER_FILE"
  chmod 644 "$DRIVER_FILE"
}

# Wait for telegram-multi to fully release its long-poll connection to the
# Telegram DCs before starting the new mode's child. If we don't wait, the
# new mode's bun process boots, calls getUpdates with the same bot token the
# previous (just-killed) child still holds open server-side, and Telegram
# returns 409 Conflict. The watchdog then reads "deaf bot" and bounces the
# new mode back. Telegram's long-poll dwell is ~50s, so we give it 60s max.
#
# After SIGTERM, telegram-multi's per-bot supervisors exit fast, but the
# server-side long-poll only releases when the underlying TCP connection
# closes — which happens on bun process exit, not on SIGTERM receipt. So we
# (1) wait for systemctl stop to return (which already waits for ExecStop),
# (2) kill any stragglers, (3) poll for absence of ESTABLISHED Telegram
# sockets across all bun procs.
release_telegram_long_polls() {
  local timeout=60
  local waited=0
  # Belt-and-braces: kill any orphan bun procs that didn't exit with the
  # parent unit (e.g. if shelly.service crashed without ExecStop).
  pkill -TERM -f "bun.*server\.ts" 2>/dev/null || true
  while [ "$waited" -lt "$timeout" ]; do
    # Any remaining bun process with an ESTABLISHED socket to a Telegram DC?
    # Telegram DCs: 149.154.160.0/20 (IPv4) + 2001:67c:4e8::/48 (IPv6) — same
    # heuristic the watchdog uses (infra/shelly-watchdog.sh).
    local has_socket=0
    while read -r pid; do
      [ -z "$pid" ] && continue
      if /usr/bin/lsof -p "$pid" -nP 2>/dev/null \
           | grep -E "ESTABLISHED" \
           | grep -Eq "(149\.154\.1[0-9]+\.|\[2001:67c:4e8:)"; then
        has_socket=1
        break
      fi
    done < <(pgrep -f "bun.*server\.ts" 2>/dev/null || true)
    if [ "$has_socket" -eq 0 ]; then
      echo "→ telegram long-polls released after ${waited}s"
      # Belt: also kill any lingering bun procs (no socket but still alive)
      # so the new mode starts from a clean slate.
      pkill -KILL -f "bun.*server\.ts" 2>/dev/null || true
      sleep 1
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  echo "→ WARNING: timed out after ${timeout}s waiting for Telegram long-polls to release. Force-killing."
  pkill -KILL -f "bun.*server\.ts" 2>/dev/null || true
  sleep 1
}

# Stop and best-effort nuke the rogue OpenClaw user-instance services if
# they're running. They are dead code per CLAUDE.md "Dead code — do not
# resurrect" but were never cleaned up; they poll Telegram with the same
# bot tokens we use, causing persistent 409 Conflict on every getUpdates
# from telegram-multi. Stops are idempotent (no-op if already stopped or
# absent). The user systemd manager runs as PID-1 of the deploy user; we
# need its XDG_RUNTIME_DIR to talk to it.
stop_openclaw_pollers() {
  local deploy_uid
  deploy_uid=$(id -u deploy 2>/dev/null || echo 1001)
  for unit in openclaw-gateway.service openclaw-node.service; do
    su - deploy -c "XDG_RUNTIME_DIR=/run/user/${deploy_uid} systemctl --user is-active --quiet ${unit}" 2>/dev/null \
      && {
        echo "→ stopping rogue ${unit} (deploy user systemd)"
        su - deploy -c "XDG_RUNTIME_DIR=/run/user/${deploy_uid} systemctl --user stop ${unit}" 2>/dev/null || true
        su - deploy -c "XDG_RUNTIME_DIR=/run/user/${deploy_uid} systemctl --user disable ${unit}" 2>/dev/null || true
      } \
      || true
  done
}

# `systemctl mask <unit>` refuses if the unit file already exists in
# /etc/systemd/system/ (only auto-masks units that live in /usr/lib/...).
# Our units are deployed to /etc/systemd/system/ by deploy-agents.sh, so
# we manually do what mask would have done: replace the file with a
# /dev/null symlink. unmask_unit puts the real file back from the repo.
# Both operations call daemon-reload so systemd picks up the change.
ETC_SYSTEMD=/etc/systemd/system
REPO_INFRA=/home/deploy/projects/dev-panel/infra
mask_unit() {
  local unit=$1
  ln -sf /dev/null "${ETC_SYSTEMD}/${unit}"
  systemctl daemon-reload
}
unmask_unit() {
  local unit=$1
  if [ -L "${ETC_SYSTEMD}/${unit}" ] && [ "$(readlink "${ETC_SYSTEMD}/${unit}")" = "/dev/null" ]; then
    cp "${REPO_INFRA}/${unit}" "${ETC_SYSTEMD}/${unit}"
    systemctl daemon-reload
  fi
}

switch_to_pi() {
  echo "→ stopping $SHELLY_CLAUDE"
  systemctl stop "$SHELLY_CLAUDE" || true
  # shelly.service is `Type=oneshot RemainAfterExit=yes` so `stop` doesn't
  # actually kill the spawned tmux/claude/bun tree. Disable+stop the unit,
  # then nuke the tmux session so claude (and its bun MCP child) actually die.
  systemctl disable "$SHELLY_CLAUDE" 2>/dev/null || true
  # Mask. After the first flip-to-pi attempts, something we couldn't trace
  # (not the watchdog, not the daily-restart timer) issued a
  # `systemctl start shelly.service` ~20s after the flip and the symmetric
  # Conflicts= then forced Pi unit down. mask_unit makes shelly.service
  # un-startable until switch_to_claude unmasks it.
  echo "→ masking $SHELLY_CLAUDE"
  mask_unit "$SHELLY_CLAUDE"
  /usr/bin/tmux -L deploy kill-session -t shelly 2>/dev/null || true
  stop_openclaw_pollers
  echo "→ waiting for telegram long-polls to release"
  release_telegram_long_polls
  echo "→ writing DRIVER_DEFAULT=pi"
  write_driver_default pi
  echo "→ unmasking + enabling + starting $SHELLY_PI"
  unmask_unit "$SHELLY_PI"
  systemctl enable "$SHELLY_PI" 2>/dev/null || true
  systemctl start "$SHELLY_PI"
  echo "→ restarting $WORKER (so ephemerals pick up DRIVER_DEFAULT=pi)"
  systemctl restart "$WORKER"
  echo
  print_status
}

switch_to_claude() {
  echo "→ stopping $SHELLY_PI"
  systemctl stop "$SHELLY_PI" || true
  systemctl disable "$SHELLY_PI" 2>/dev/null || true
  echo "→ masking $SHELLY_PI"
  mask_unit "$SHELLY_PI"
  stop_openclaw_pollers
  echo "→ waiting for telegram long-polls to release"
  release_telegram_long_polls
  echo "→ writing DRIVER_DEFAULT=claude"
  write_driver_default claude
  echo "→ unmasking + enabling + starting $SHELLY_CLAUDE"
  unmask_unit "$SHELLY_CLAUDE"
  systemctl enable "$SHELLY_CLAUDE" 2>/dev/null || true
  systemctl start "$SHELLY_CLAUDE"
  echo "→ restarting $WORKER (so ephemerals pick up DRIVER_DEFAULT=claude)"
  systemctl restart "$WORKER"
  echo
  print_status
}

case "${1:-}" in
  pi)     switch_to_pi ;;
  claude) switch_to_claude ;;
  status) print_status ;;
  *)      usage ;;
esac
