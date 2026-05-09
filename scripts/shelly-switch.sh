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

print_status() {
  local mode
  mode=$(current_mode)
  echo "Shelly mode:        $mode"
  echo "shelly.service:     $(systemctl is-active "$SHELLY_CLAUDE" 2>/dev/null || echo inactive)"
  echo "shelly-pi.service:  $(systemctl is-active "$SHELLY_PI" 2>/dev/null || echo inactive)"
  echo "DRIVER_DEFAULT:     $(cat "$DRIVER_FILE" 2>/dev/null | grep -E '^DRIVER_DEFAULT' || echo '(unset)')"
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

switch_to_pi() {
  echo "→ stopping $SHELLY_CLAUDE"
  systemctl stop "$SHELLY_CLAUDE" || true
  echo "→ writing DRIVER_DEFAULT=pi"
  write_driver_default pi
  echo "→ starting $SHELLY_PI"
  systemctl start "$SHELLY_PI"
  echo "→ restarting $WORKER (so ephemerals pick up DRIVER_DEFAULT=pi)"
  systemctl restart "$WORKER"
  echo
  print_status
}

switch_to_claude() {
  echo "→ stopping $SHELLY_PI"
  systemctl stop "$SHELLY_PI" || true
  echo "→ writing DRIVER_DEFAULT=claude"
  write_driver_default claude
  echo "→ starting $SHELLY_CLAUDE"
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
