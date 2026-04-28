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
PLANE_SHELLY_EMAIL=$(ssh "$SERVICES_HOST" 'grep ^PLANE_SHELLY_EMAIL= ~/dev-panel/.env.production | cut -d= -f2')
PLANE_SHELLY_PASS=$(ssh "$SERVICES_HOST" 'grep ^PLANE_SHELLY_PASSWORD= ~/dev-panel/.env.production | cut -d= -f2')

# Sanity check — all non-empty
for v in PG_PASS ADMIN_KEY VOYAGE_KEY TG_TOKEN TG_CHAT GH_TOKEN PLANE_KEY PLANE_SHELLY_EMAIL PLANE_SHELLY_PASS; do
  [ -n "${!v}" ] || { echo "missing secret: $v"; exit 1; }
done

echo "==> deploying to agents (${AGENTS_HOST})"
ssh "$AGENTS_HOST" bash -s <<EOF
set -e
# System deps — jq is required by Shelly's PreToolUse hook that scopes Read
# to the telegram inbox. Without it every Read call fails.
command -v jq >/dev/null 2>&1 || apt-get install -y jq >/dev/null

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
PLANE_SHELLY_EMAIL=${PLANE_SHELLY_EMAIL}
PLANE_SHELLY_PASSWORD=${PLANE_SHELLY_PASS}
ENVEOF
chown deploy:deploy /home/deploy/projects/dev-panel/.env.agent
chmod 600 /home/deploy/projects/dev-panel/.env.agent

# Pin the git origin remote to use the token for HTTPS pushes so builder
# agents can push branches without interactive auth. Re-applied every
# deploy in case the token rotates.
su - deploy -c "cd /home/deploy/projects/dev-panel && \\
  git remote set-url origin \\
    https://x-access-token:${GH_TOKEN}@github.com/franckbirba/dev-panel.git"

# /home/deploy/.mcp.json — Shelly's MCP server config (devpanel-mcp, plane,
# github). The devpanel-mcp env block here is load-bearing: src/mcp/server.js
# defaults REDIS_HOST to the public IP 77.42.46.87 (firewalled), which makes
# every list_jobs/enqueue_job hang forever. Render the template with secrets
# from .env.production so we never drift between hosts.
sed \
  -e "s|__PLANE_API_KEY__|${PLANE_KEY}|" \
  -e "s|__PLANE_SHELLY_EMAIL__|${PLANE_SHELLY_EMAIL}|" \
  -e "s|__PLANE_SHELLY_PASSWORD__|${PLANE_SHELLY_PASS}|" \
  -e "s|__GITHUB_TOKEN__|${GH_TOKEN}|" \
  -e "s|__PG_PASSWORD__|${PG_PASS}|" \
  -e "s|__VOYAGE_API_KEY__|${VOYAGE_KEY}|" \
  -e "s|__ADMIN_API_KEY__|${ADMIN_KEY}|" \
  /home/deploy/projects/dev-panel/infra/agents-mcp.json.template \
  > /home/deploy/.mcp.json
chown deploy:deploy /home/deploy/.mcp.json
chmod 600 /home/deploy/.mcp.json

# Shelly's Claude settings — deny list + PreToolUse hook that enforces her
# orchestration-only role. Source of truth is in the repo so settings drift
# between the agents host and the repo is impossible.
install -d -o deploy -g deploy /home/deploy/.claude
install -o deploy -g deploy -m 0644 \
  /home/deploy/projects/dev-panel/infra/claude/shelly-settings.json \
  /home/deploy/.claude/settings.json

# Plugin: telegram-multi (multi-tenant Telegram channel for Shelly).
# Source of truth is in the repo (plugins/telegram-multi/); we sync it into
# the deploy user's plugin install location and install bun deps.
install -d -o deploy -g deploy /home/deploy/.claude/plugins
rsync -av --delete \
  --exclude node_modules --exclude bun.lock \
  /home/deploy/projects/dev-panel/plugins/telegram-multi/ \
  /home/deploy/.claude/plugins/telegram-multi/
chown -R deploy:deploy /home/deploy/.claude/plugins/telegram-multi
su - deploy -c 'cd /home/deploy/.claude/plugins/telegram-multi && /home/deploy/.bun/bin/bun install --no-summary'

# Systemd units (worker + shelly + watchdog + relay + daily-restart)
cp /home/deploy/projects/dev-panel/infra/devpanel-worker.service /etc/systemd/system/
cp /home/deploy/projects/dev-panel/infra/shelly.service /etc/systemd/system/
cp /home/deploy/projects/dev-panel/infra/shelly-watchdog.service /etc/systemd/system/
cp /home/deploy/projects/dev-panel/infra/shelly-watchdog.timer /etc/systemd/system/
cp /home/deploy/projects/dev-panel/infra/shelly-relay.service /etc/systemd/system/
cp /home/deploy/projects/dev-panel/infra/shelly-daily-restart.service /etc/systemd/system/
cp /home/deploy/projects/dev-panel/infra/shelly-daily-restart.timer /etc/systemd/system/

# Watchdog script must be executable and on the deploy user's PATH.
install -d -o deploy -g deploy /home/deploy/bin /home/deploy/logs
install -o deploy -g deploy -m 0755 \
  /home/deploy/projects/dev-panel/infra/shelly-watchdog.sh \
  /home/deploy/bin/shelly-watchdog.sh

# PostToolUse memory-reminder hook — referenced by shelly-settings.json.
install -o deploy -g deploy -m 0755 \
  /home/deploy/projects/dev-panel/infra/claude/hooks/shelly-memory-reminder.sh \
  /home/deploy/bin/shelly-memory-reminder.sh

systemctl daemon-reload
systemctl enable devpanel-worker shelly.service shelly-watchdog.timer shelly-relay.service shelly-daily-restart.timer
systemctl restart devpanel-worker
systemctl restart shelly-relay.service
# Reload shelly only if it's running; do not start a kill cascade if a human
# is debugging by attaching to the tmux. Watchdog will pick it up if needed.
if systemctl is-active --quiet shelly.service; then
  systemctl reload-or-restart shelly.service || true
fi
systemctl restart shelly-watchdog.timer
systemctl restart shelly-daily-restart.timer

sleep 3
if systemctl is-active devpanel-worker > /dev/null; then
  echo "==> worker active — recent log:"
  journalctl -u devpanel-worker --no-pager -n 5 -o cat | tail -5
else
  echo "==> worker FAILED to start:"
  journalctl -u devpanel-worker --no-pager -n 20 -o cat | tail -20
  exit 1
fi

# Smoke test: confirm telegram-multi is actually polling every active bot,
# not just that bun is alive. Wait for the health.json heartbeat tick (15s)
# before checking — the bots connect within 10s of restart but the file
# isn't written until the first interval fires.
echo "==> waiting 25s for telegram-multi to settle, then smoke testing"
sleep 25
if su - deploy -c "/home/deploy/projects/dev-panel/scripts/smoke-shelly.sh"; then
  echo "==> smoke green"
else
  echo "==> SMOKE FAILED — Shelly is partially deaf, deploy NOT successful"
  exit 1
fi
EOF

echo "==> done"
