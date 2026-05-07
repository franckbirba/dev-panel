#!/usr/bin/env bash
# scripts/tmux-observe.sh — read-only observation tmux on hetzner-vps.
#
# Runs as user `deploy` on the agents host. Creates (or attaches to) a
# tmux session `observe` on the default socket. The session has one
# window with four panes:
#   top-left   : tmux -L deploy attach -t shelly -r  (read-only Shelly)
#   top-right  : journalctl -fu shelly.service
#   bottom-left: journalctl -fu devpanel-worker.service
#   bottom-right: telegram-multi health.json + redis ping (watch -n 5)
#
# Invoke from your Mac:
#   ssh hetzner-vps 'su - deploy -c "/home/deploy/projects/dev-panel/scripts/tmux-observe.sh"'

set -euo pipefail

SESSION="observe"

# Already running? Attach and exit.
if tmux has-session -t "$SESSION" 2>/dev/null; then
  exec tmux attach -t "$SESSION"
fi

# Top-left: live Shelly, read-only.
tmux new-session -d -s "$SESSION" -n observe \
  "tmux -L deploy attach -t shelly -r || exec \$SHELL"

# Top-right: Shelly's systemd log.
tmux split-window -h -t "$SESSION:observe" \
  "journalctl -fu shelly.service || exec \$SHELL"

# Bottom-left: worker log. Split pane 0 (top-left, Shelly) vertically.
tmux split-window -v -t "$SESSION:observe.0" \
  "journalctl -fu devpanel-worker.service || exec \$SHELL"

# Bottom-right: telegram-multi health + redis ping. Split the top-right
# (shelly journal) pane vertically. Note: tmux renumbers panes
# left-to-right top-to-bottom after each split, so after the previous
# split the original right pane (was index 1) is now index 2.
HEALTH_CMD='jq . /home/deploy/logs/telegram-multi/health.json 2>/dev/null; echo; redis-cli -h 10.0.0.2 ping 2>/dev/null'
tmux split-window -v -t "$SESSION:observe.2" \
  "watch -n 5 '$HEALTH_CMD' || exec \$SHELL"

# Land on the Shelly pane.
tmux select-pane -t "$SESSION:observe.0"

exec tmux attach -t "$SESSION"
