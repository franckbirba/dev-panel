#!/usr/bin/env bash
# scripts/tmux-cockpit.sh — Shelly mission-control on your Mac.
#
# Idempotent: attaches to the existing `devpanl` tmux session if running,
# otherwise creates one with 7 windows aimed at production:
#   1 shelly        — read-only attach to live Shelly on hetzner-vps
#   2 shelly-log    — journalctl -fu shelly.service (hetzner-vps)
#   3 worker-log    — journalctl -fu devpanel-worker.service (hetzner-vps)
#   4 tg-health     — watch telegram-multi health.json + redis ping (hetzner-vps)
#   5 agents-shell  — interactive shell on hetzner-vps as deploy, in repo
#   6 services      — interactive shell on services VPS as deploy, in repo
#   7 local         — local repo shell (git, edits, ./scripts/deploy-agents.sh)
#
# Prerequisites:
#   - tmux 3.x on PATH
#   - SSH aliases `hetzner-vps` and a working route to deploy@77.42.46.87
#     for the services VPS (we use the IP directly because there is no
#     `services-vps` alias by convention).
#   - Run from anywhere — script resolves repo root via its own location.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCKET="devpanl"
SESSION="devpanl"
CONF="$REPO_ROOT/scripts/tmux/devpanl.conf"

# `ssh -tt` is required for any window that runs an interactive thing
# (tmux attach, journalctl -f, watch, an interactive shell) over SSH —
# without -tt the inner process gets no TTY and either errors out
# ("open terminal failed") or behaves non-interactively.
SSH_AGENTS="ssh -tt hetzner-vps"
SSH_SERVICES="ssh -tt deploy@77.42.46.87"

TMUX="tmux -L $SOCKET -f $CONF"

# Already running? Attach and exit.
if $TMUX has-session -t "$SESSION" 2>/dev/null; then
  exec $TMUX attach -t "$SESSION"
fi

cd "$REPO_ROOT"

# Window 1: shelly — read-only attach to the live Shelly tmux on hetzner-vps.
# `-r` keeps the pane read-only so accidental keystrokes don't reach Claude.
$TMUX new-session -d -s "$SESSION" -n shelly \
  "$SSH_AGENTS 'su - deploy -c \"tmux -L deploy attach -t shelly -r\"' || exec \$SHELL"

# Window 2: shelly-log — Shelly's systemd journal, follow.
$TMUX new-window -t "$SESSION" -n shelly-log \
  "$SSH_AGENTS 'journalctl -fu shelly.service' || exec \$SHELL"

# Window 3: worker-log — devpanel-worker journal, follow.
$TMUX new-window -t "$SESSION" -n worker-log \
  "$SSH_AGENTS 'journalctl -fu devpanel-worker.service' || exec \$SHELL"

# Window 4: tg-health — telegram-multi health.json + redis ping every 5s.
# The remote `watch` evaluates the inner command shell-side; we double-quote
# the outer ssh argument and single-quote the watch payload so substitutions
# happen on the VPS, not locally.
$TMUX new-window -t "$SESSION" -n tg-health \
  "$SSH_AGENTS \"watch -n 5 'jq . /home/deploy/logs/telegram-multi/health.json 2>/dev/null; echo; redis-cli -h 10.0.0.2 ping 2>/dev/null'\" || exec \$SHELL"

# Window 5: agents-shell — interactive shell on hetzner-vps, in the repo.
$TMUX new-window -t "$SESSION" -n agents-shell \
  "$SSH_AGENTS 'su - deploy -c \"cd /home/deploy/projects/dev-panel && exec bash -l\"' || exec \$SHELL"

# Window 6: services — interactive shell on services VPS, in the repo.
$TMUX new-window -t "$SESSION" -n services \
  "$SSH_SERVICES 'cd ~/dev-panel && exec bash -l' || exec \$SHELL"

# Window 7: local — local repo shell. Lands you in dev-panel for git/edits
# and running ./scripts/deploy-agents.sh.
$TMUX new-window -t "$SESSION" -n local -c "$REPO_ROOT"

# Land on Shelly.
$TMUX select-window -t "$SESSION:shelly"

exec $TMUX attach -t "$SESSION"
