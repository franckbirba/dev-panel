#!/usr/bin/env bash
# scripts/tmux/loop-ssh.sh — reconnect-on-drop wrapper for cockpit panes.
#
# Usage: loop-ssh.sh <ssh-host> <remote-command-string>
#
# Keeps reconnecting whenever ssh exits, so a flaky network / laptop sleep
# doesn't kill the pane. `autossh -M 0` adds a second respawn layer that
# relies on ssh's ServerAlive* probes (~/.ssh/config: 15s × 4).
#
# Press any key during the 2s reconnect pause to abort the loop.

set -u

HOST="$1"
shift
REMOTE_CMD="$*"

export AUTOSSH_GATETIME=0

# Reap our autossh child if the pane is closed (tmux SIGHUP) — otherwise
# autossh detaches and lingers, and the next cockpit launch fights it for
# ssh slots until you `pkill -f autossh` by hand.
trap 'kill -TERM "$AUTOSSH_PID" 2>/dev/null; exit 0' TERM HUP INT

while true; do
  printf '\033[2;36m[cockpit] connecting to %s…\033[0m\n' "$HOST"
  autossh -M 0 -tt "$HOST" "$REMOTE_CMD" &
  AUTOSSH_PID=$!
  wait "$AUTOSSH_PID"
  ec=$?
  printf '\033[2;33m[cockpit] %s disconnected (exit=%d). Reconnecting in 2s — any key to abort.\033[0m\n' "$HOST" "$ec"
  if read -t 2 -n 1 -r _; then
    printf '\033[2;31m[cockpit] aborted by user.\033[0m\n'
    exec "$SHELL"
  fi
done
