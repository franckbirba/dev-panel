#!/usr/bin/env bash
# Idempotent: provision the storybook-sync system user on the services VPS.
# Run as root on the services VPS. Safe to re-run.
#
# What it does:
#   1. Creates user 'storybook-sync' with no login shell.
#   2. Creates /var/lib/devpanl/storybook-stories/ owned by that user.
#   3. Installs authorized_keys with command= restriction that pins rsync
#      into a per-project subdirectory chosen by the caller workflow.
#
# Per-project SSH keys are added as additional entries. Each entry pins
# rsync to a specific subdirectory so a leak in project A's key cannot
# overwrite project B's stories.
set -euo pipefail

USER_NAME="storybook-sync"
HOME_DIR="/var/lib/devpanl/storybook-stories"
AUTH_KEYS="$HOME_DIR/.ssh/authorized_keys"

if ! id "$USER_NAME" &>/dev/null; then
  useradd --system \
    --home-dir "$HOME_DIR" \
    --create-home \
    --shell /usr/sbin/nologin \
    "$USER_NAME"
  echo "Created system user $USER_NAME"
else
  echo "User $USER_NAME already exists"
fi

mkdir -p "$HOME_DIR/.ssh"
chown -R "$USER_NAME:$USER_NAME" "$HOME_DIR"
chmod 700 "$HOME_DIR/.ssh"

touch "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"
chown "$USER_NAME:$USER_NAME" "$AUTH_KEYS"

cat <<'HELP'

Next steps — manual, per project:

  1. Generate a project-specific keypair on the developer machine:
       ssh-keygen -t ed25519 -f ~/.ssh/storybook-sync-<project> -N ''

  2. Store the PRIVATE key as the caller repo's SYNC_SSH_KEY secret.

  3. Append the PUBLIC key to this host's authorized_keys, gated by a
     command= restriction that pins rsync to /<project>/:

       command="rrsync -wo /var/lib/devpanl/storybook-stories/<project>",
       no-agent-forwarding,no-port-forwarding,no-pty,no-X11-forwarding
       ssh-ed25519 AAAA... user@host

     (rrsync ships with rsync; on Debian/Ubuntu:
        /usr/share/doc/rsync/scripts/rrsync )

  4. Create the project subdirectory:
       install -d -o storybook-sync -g storybook-sync \
         /var/lib/devpanl/storybook-stories/<project>

  5. Bind the storybook container so its /stories/ mount includes the
     new subdirectory. Since the compose volume covers the whole parent
     folder, no change is needed — the new dir appears immediately.

HELP

echo "Done. See the block above for per-project onboarding."
