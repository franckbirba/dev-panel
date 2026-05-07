#!/usr/bin/env bash
# scripts/tmux-cockpit.sh — local devpanl cockpit launcher.
#
# Idempotent: attaches to an existing `devpanl` tmux session if one is
# running, otherwise creates a fresh one with 6 windows:
#   1 api    — node bin/dev-panel.js serve (auto-restart on crash)
#   2 dash   — npm run dev:dashboard (Vite)
#   3 worker — split: shell hint (top) + redis-cli monitor (bottom)
#   4 mcp    — split: shell in src/mcp (top) + shell hint (bottom)
#   5 shelly — read-only attach to live Shelly on hetzner-vps
#   6 git    — scratch shell at repo root
#
# Prerequisites:
#   - tmux 3.x on PATH
#   - SSH alias `hetzner-vps` configured (used by the shelly window)
#   - Run from anywhere — script resolves repo root via its own location.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCKET="devpanl"
SESSION="devpanl"
CONF="$REPO_ROOT/scripts/tmux/devpanl.conf"

TMUX="tmux -L $SOCKET -f $CONF"

# Already running? Attach and exit.
if $TMUX has-session -t "$SESSION" 2>/dev/null; then
  exec $TMUX attach -t "$SESSION"
fi

cd "$REPO_ROOT"

# Window 1: api — auto-restart loop so a crash leaves a visible message.
$TMUX new-session -d -s "$SESSION" -n api -c "$REPO_ROOT" \
  "while true; do node bin/dev-panel.js serve; echo; echo '[api exited \$?, restarting in 2s — Ctrl-C to stop]'; sleep 2; done"

# Window 2: dash
$TMUX new-window -t "$SESSION" -n dash -c "$REPO_ROOT" \
  "npm run dev:dashboard"

# Window 3: worker — horizontal split, hint comments in shells.
$TMUX new-window -t "$SESSION" -n worker -c "$REPO_ROOT"
$TMUX send-keys -t "$SESSION:worker" \
  "# tail -F path/to/worker.log    # uncomment when worker is running locally" Enter
$TMUX split-window -v -t "$SESSION:worker" -c "$REPO_ROOT" \
  "redis-cli -h 127.0.0.1 monitor || exec \$SHELL"

# Window 4: mcp — horizontal split.
$TMUX new-window -t "$SESSION" -n mcp -c "$REPO_ROOT/src/mcp"
$TMUX split-window -v -t "$SESSION:mcp" -c "$REPO_ROOT"
$TMUX send-keys -t "$SESSION:mcp.2" \
  "# tail -F path/to/mcp.log       # uncomment when MCP server is running locally" Enter

# Window 5: shelly — read-only attach to the live Shelly tmux on hetzner-vps.
$TMUX new-window -t "$SESSION" -n shelly \
  "ssh hetzner-vps 'su - deploy -c \"tmux -L deploy attach -t shelly -r\"' || exec \$SHELL"

# Window 6: git — plain shell.
$TMUX new-window -t "$SESSION" -n git -c "$REPO_ROOT"

# Land on api.
$TMUX select-window -t "$SESSION:api"

exec $TMUX attach -t "$SESSION"
