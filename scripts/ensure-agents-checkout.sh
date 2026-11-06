#!/usr/bin/env bash
set -euo pipefail

REPO=/home/deploy/projects/dev-panel

if sudo -u deploy git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

RECOVERY=$(mktemp -d /home/deploy/dev-panel-recovery.XXXXXX)
trap 'rm -rf "$RECOVERY"' EXIT

sudo -u deploy git clone --no-checkout https://github.com/franckbirba/dev-panel.git "$RECOVERY/repo"
sudo -u deploy mkdir -p "$REPO"
sudo -u deploy cp -a "$RECOVERY/repo/.git" "$REPO/.git"
sudo -u deploy git -C "$REPO" reset --hard origin/main
