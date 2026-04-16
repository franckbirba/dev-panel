#!/usr/bin/env bash
# scripts/deploy-agents.sh — update the worker on the agents node.
#
# Run from a machine that has the hetzner-vps SSH key (root@62.238.0.167).
# Pulls latest code, refreshes .env.agent from the services-node .env.production,
# updates the systemd unit, and restarts devpanel-worker.
#
# Requires the `hetzner-vps` SSH config entry (in ~/.ssh/config) and local
# access to `deploy@77.42.46.87` for fetching secrets.

set -euo pipefail

SERVICES_HOST="${SERVICES_HOST:-deploy@77.42.46.87}"
AGENTS_HOST="${AGENTS_HOST:-hetzner-vps}"   # root@62.238.0.167

echo "==> fetching secrets from services (${SERVICES_HOST})"
PG_PASS=$(ssh "$SERVICES_HOST" 'grep ^AFFINE_DB_PASSWORD= ~/dev-panel/.env.production | cut -d= -f2')
ADMIN_KEY=$(ssh "$SERVICES_HOST" 'grep ^ADMIN_API_KEY= ~/dev-panel/.env.production | cut -d= -f2')
VOYAGE_KEY=$(ssh "$SERVICES_HOST" 'grep ^VOYAGE_API_KEY= ~/dev-panel/.env.production | cut -d= -f2')
TG_TOKEN=$(ssh "$SERVICES_HOST" 'grep ^TELEGRAM_BOT_TOKEN= ~/dev-panel/.env.production | cut -d= -f2')
TG_CHAT=$(ssh "$SERVICES_HOST" 'grep ^TELEGRAM_CHAT_ID= ~/dev-panel/.env.production | cut -d= -f2')
GH_TOKEN=$(ssh "$SERVICES_HOST" 'grep ^GITHUB_TOKEN= ~/dev-panel/.env.production | cut -d= -f2')
PLANE_KEY=$(ssh "$SERVICES_HOST" 'grep ^PLANE_API_KEY= ~/dev-panel/.env.production | cut -d= -f2')

# Sanity check — all non-empty
for v in PG_PASS ADMIN_KEY VOYAGE_KEY TG_TOKEN TG_CHAT GH_TOKEN PLANE_KEY; do
  [ -n "${!v}" ] || { echo "missing secret: $v"; exit 1; }
done

echo "==> deploying to agents (${AGENTS_HOST})"
ssh "$AGENTS_HOST" bash -s <<EOF
set -e
# Code + deps (as deploy user)
su - deploy -c 'cd /home/deploy/projects/dev-panel && git pull --ff-only'
su - deploy -c 'cd /home/deploy/projects/dev-panel && npm install --production --silent'

# Secrets
cat > /home/deploy/projects/dev-panel/.env.agent <<ENVEOF
PG_PASSWORD=${PG_PASS}
VOYAGE_API_KEY=${VOYAGE_KEY}
ADMIN_API_KEY=${ADMIN_KEY}
TELEGRAM_BOT_TOKEN=${TG_TOKEN}
TELEGRAM_CHAT_ID=${TG_CHAT}
GITHUB_TOKEN=${GH_TOKEN}
PLANE_API_KEY=${PLANE_KEY}
ENVEOF
chown deploy:deploy /home/deploy/projects/dev-panel/.env.agent
chmod 600 /home/deploy/projects/dev-panel/.env.agent

# Pin the git origin remote to use the token for HTTPS pushes so builder
# agents can push branches without interactive auth. Re-applied every
# deploy in case the token rotates.
su - deploy -c "cd /home/deploy/projects/dev-panel && \\
  git remote set-url origin \\
    https://x-access-token:${GH_TOKEN}@github.com/franckbirba/dev-panel.git"

# Systemd unit
cp /home/deploy/projects/dev-panel/infra/devpanel-worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable devpanel-worker
systemctl restart devpanel-worker

sleep 3
if systemctl is-active devpanel-worker > /dev/null; then
  echo "==> worker active — recent log:"
  journalctl -u devpanel-worker --no-pager -n 5 -o cat | tail -5
else
  echo "==> worker FAILED to start:"
  journalctl -u devpanel-worker --no-pager -n 20 -o cat | tail -20
  exit 1
fi
EOF

echo "==> done"
