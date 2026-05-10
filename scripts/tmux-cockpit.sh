#!/usr/bin/env bash
# scripts/tmux-cockpit.sh — Shelly mission-control on your Mac.
#
# Idempotent: attaches to the existing `devpanl` tmux session if running,
# otherwise creates one with 8 windows aimed at production:
#   1 shelly        — read-only attach to live Shelly on hetzner-vps
#   2 shelly-log    — journalctl -fu shelly.service (hetzner-vps)
#   3 worker-log    — journalctl -fu devpanel-worker.service (hetzner-vps)
#   4 tg-health     — watch telegram-multi health.json + redis ping (hetzner-vps)
#   5 agents-shell  — interactive shell on hetzner-vps as deploy, in repo
#   6 services      — interactive shell on services VPS as deploy, in repo
#   7 local         — local repo shell (git, edits, ./scripts/deploy-agents.sh)
#   8 agents-files  — yazi (TUI file explorer) on hetzner-vps, rooted in repo
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

# Each SSH-backed pane runs through `scripts/tmux/loop-ssh.sh`, which keeps
# reconnecting on drop (~2s pause) so the pane content returns by itself.
# `remain-on-exit on` (devpanl.conf) keeps the pane visible if the loop ever
# exits; `prefix R` respawns it. `loop-ssh.sh` itself uses `autossh -M 0`
# for a second respawn layer relying on ssh's ServerAlive* probes
# (15s × 4 in ~/.ssh/config). `-tt` is required inside loop-ssh.sh for
# interactive remote processes (tmux attach, journalctl -f, watch, shells).
LOOP_SSH="$REPO_ROOT/scripts/tmux/loop-ssh.sh"
SSH_AGENTS_HOST="hetzner-vps"
SSH_SERVICES_HOST="deploy@77.42.46.87"

TMUX="tmux -L $SOCKET -f $CONF"

# Already running? Attach and exit.
if $TMUX has-session -t "$SESSION" 2>/dev/null; then
  exec $TMUX attach -t "$SESSION"
fi

cd "$REPO_ROOT"

# Window 1: shelly — writable attach to the live Shelly tmux on hetzner-vps.
# Keystrokes reach Claude — careful. Use `Ctrl-b d` to detach.
$TMUX new-session -d -s "$SESSION" -n shelly \
  "$LOOP_SSH $SSH_AGENTS_HOST 'su - deploy -c \"tmux -L deploy attach -t shelly\"'"

# Window 2: shelly-log — Shelly's systemd journal, follow.
$TMUX new-window -t "$SESSION" -n shelly-log \
  "$LOOP_SSH $SSH_AGENTS_HOST 'journalctl -fu shelly.service'"

# Window 3: worker-log — devpanel-worker journal, follow.
$TMUX new-window -t "$SESSION" -n worker-log \
  "$LOOP_SSH $SSH_AGENTS_HOST 'journalctl -fu devpanel-worker.service'"

# Window 4: tg-health — telegram-multi health.json + redis ping every 5s.
$TMUX new-window -t "$SESSION" -n tg-health \
  "$LOOP_SSH $SSH_AGENTS_HOST \"watch -n 5 'jq . /home/deploy/logs/telegram-multi/health.json 2>/dev/null; echo; redis-cli -h 10.0.0.2 ping 2>/dev/null'\""

# Window 5: agents-shell — interactive shell on hetzner-vps, in the repo.
$TMUX new-window -t "$SESSION" -n agents-shell \
  "$LOOP_SSH $SSH_AGENTS_HOST 'su - deploy -c \"cd /home/deploy/projects/dev-panel && exec bash -l\"'"

# Window 6: services — interactive shell on services VPS, in the repo.
# `bash -il` (interactive + login) is required: `-l` alone reads profile but
# isn't interactive over SSH, so the pane shows the prompt but swallows keys.
$TMUX new-window -t "$SESSION" -n services \
  "$LOOP_SSH $SSH_SERVICES_HOST 'cd ~/dev-panel && exec bash -il'"

# Window 7: local — local repo shell. Lands you in dev-panel for git/edits
# and running ./scripts/deploy-agents.sh.
$TMUX new-window -t "$SESSION" -n local -c "$REPO_ROOT"

# Window 8: agents-files — yazi on hetzner-vps as deploy, rooted in the
# project. When yazi exits (q), the bash login shell behind it stays so the
# pane doesn't disappear; relaunch with `yazi` or just type other commands.
$TMUX new-window -t "$SESSION" -n agents-files \
  "$LOOP_SSH $SSH_AGENTS_HOST 'su - deploy -c \"cd /home/deploy/projects/dev-panel && yazi; exec bash -l\"'"

# Land on Shelly.
$TMUX select-window -t "$SESSION:shelly"

exec $TMUX attach -t "$SESSION"
