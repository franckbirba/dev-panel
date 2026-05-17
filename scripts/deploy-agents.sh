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

# When this script runs on the agents host itself (e.g. via the self-hosted
# GitHub runner inside .github/workflows/deploy-agents.yml), the `ssh
# hetzner-vps` step below can't resolve its own hostname. Detect that and
# run the heredoc body locally via `sudo bash -s` instead. Override with
# AGENTS_LOCAL=1 / 0 if the detection misfires.
if [ -z "${AGENTS_LOCAL:-}" ]; then
  if [ -f /home/deploy/projects/dev-panel/.git/config ] \
     && [ -d /home/deploy/.bun ] \
     && command -v systemctl >/dev/null 2>&1; then
    AGENTS_LOCAL=1
  else
    AGENTS_LOCAL=0
  fi
fi

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
AGENT_HUB_TOKEN=$(ssh "$SERVICES_HOST" 'grep ^AGENT_HUB_TOKEN= ~/dev-panel/.env.production | cut -d= -f2')
# AFFINE_API_TOKEN is shelly@devpanl.dev's personal access token (`ut_*`).
# Generated once via the GraphQL `generateUserAccessToken` mutation as Shelly
# (Affine 0.26.6 has no UI for this). To rotate: log into affine.devpanl.dev
# as shelly, run the mutation again, paste the new token into .env.production.
AFFINE_TOKEN=$(ssh "$SERVICES_HOST" 'grep ^AFFINE_API_TOKEN= ~/dev-panel/.env.production | cut -d= -f2')
# GLITCHTIP_API_TOKEN is generated in the GlitchTip UI (Profile → Auth Tokens)
# with org:admin + project:admin + project:write scopes. Used by the
# devpanel-mcp glitchtip_get_issue / glitchtip_resolve_issue tools so Shelly
# and ephemeral agents can triage and close issues. Bridge alerts (push)
# stay on GLITCHTIP_BRIDGE_HMAC_SECRET — separate secret.
GLITCHTIP_TOKEN=$(ssh "$SERVICES_HOST" 'grep ^GLITCHTIP_API_TOKEN= ~/dev-panel/.env.production | cut -d= -f2 || true')
# DeepInfra OpenAI-compat — feeds Pi (cheap-tier harness) and Pi-Shelly
# fallback when Claude Max quota is exhausted. CLAUDE.md "Cheap-tier
# harness" + "Quota fallback" sections explain. OPENAI_API_KEY mirrors
# the same value because pi/goose's openai provider reads OPENAI_API_KEY,
# not DEEPINFRA_API_KEY.
DEEPINFRA_KEY=$(ssh "$SERVICES_HOST" 'grep ^DEEPINFRA_API_KEY= ~/dev-panel/.env.production | cut -d= -f2 || true')

# AGENT_HUB_URL is fixed to the public services VPS — workers connect over
# the public Internet via Traefik (TLS, bearer-token auth) rather than over
# the private 10.0.0.0/24 network. That keeps agents-host portable: we can
# move it without touching the URL.
AGENT_HUB_URL="${AGENT_HUB_URL:-https://devpanl.dev}"

# Sanity check — all non-empty. AGENT_HUB_TOKEN is generated on first
# services deploy, so on the very first agents deploy you'll need to
# trigger a services deploy first (CI on push to main).
for v in PG_PASS ADMIN_KEY VOYAGE_KEY TG_TOKEN TG_CHAT GH_TOKEN PLANE_KEY PLANE_SHELLY_EMAIL PLANE_SHELLY_PASS AGENT_HUB_TOKEN AFFINE_TOKEN; do
  [ -n "${!v}" ] || { echo "missing secret: $v"; exit 1; }
done

if [ "$AGENTS_LOCAL" = "1" ]; then
  echo "==> deploying to agents (local — detected on hetzner-vps)"
  AGENTS_RUN=(sudo bash -s)
else
  echo "==> deploying to agents (${AGENTS_HOST})"
  AGENTS_RUN=(ssh "$AGENTS_HOST" bash -s)
fi
"${AGENTS_RUN[@]}" <<EOF
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
# Agent socket.io hub — worker connects to services-API over TLS using
# this bearer token. The same token must be set on services-VPS
# .env.production (auto-generated by infra/init.sh and shared via this
# script). AGENT_HUB_URL is the public devpanel domain; Traefik routes
# /agents/* to the devpanel container.
AGENT_HUB_URL=${AGENT_HUB_URL}
AGENT_HUB_TOKEN=${AGENT_HUB_TOKEN}
# Cheap-tier harness — Pi/goose via DeepInfra. Worker reads these for
# the pi-driver path (DRIVER_DEFAULT=pi). Pi-Shelly fallback (shelly-pi.service)
# also reads them via EnvironmentFile=-/home/deploy/projects/dev-panel/.env.agent.
DEEPINFRA_API_KEY=${DEEPINFRA_KEY}
OPENAI_API_KEY=${DEEPINFRA_KEY}
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
  -e "s|__AFFINE_API_TOKEN__|${AFFINE_TOKEN}|" \
  -e "s|__GLITCHTIP_API_TOKEN__|${GLITCHTIP_TOKEN}|" \
  /home/deploy/projects/dev-panel/infra/agents-mcp.json.template \
  > /home/deploy/.mcp.json
chown deploy:deploy /home/deploy/.mcp.json
chmod 600 /home/deploy/.mcp.json

# Shelly's Claude settings — deny list + PreToolUse hook that enforces her
# orchestration-only role. Source of truth is in the repo so settings drift
# between the agents host and the repo is impossible.
#
# CRITICAL — two-file split:
#   ~/.claude/settings.json   = user-global, MUST stay minimal. Every
#     'claude -p' reads this unconditionally and merges it. If we put
#     Shelly's deny list here, every ephemeral builder spawned by the
#     worker inherits the deny -> loses Bash/Edit/Read -> fails in
#     ToolSearch loops.
#   ~/.claude/shelly-settings.json = Shelly-only. Loaded explicitly via
#     --settings in shelly.service ExecStart. Contains the deny list and
#     hooks. Ephemeral builders never see this file.
install -d -o deploy -g deploy /home/deploy/.claude
install -o deploy -g deploy -m 0644 \
  /home/deploy/projects/dev-panel/infra/claude/settings-user-minimal.json \
  /home/deploy/.claude/settings.json
install -o deploy -g deploy -m 0644 \
  /home/deploy/projects/dev-panel/infra/claude/shelly-settings.json \
  /home/deploy/.claude/shelly-settings.json

# Worker-specific MCP config — same pattern, isolation purpose. Strips the
# 'telegram' entry from the ambient ~/.mcp.json so ephemerals don't spawn
# parasitic telegram-multi pollers and race Shelly. Source of truth: the
# user-global ~/.mcp.json minus the telegram block.
jq 'del(.mcpServers.telegram)' /home/deploy/.mcp.json \
  > /home/deploy/.mcp-worker.json
chown deploy:deploy /home/deploy/.mcp-worker.json
chmod 600 /home/deploy/.mcp-worker.json

# Pi-Shelly MCP config — same content as .mcp-worker.json (telegram stripped).
# Used by scripts/shelly-pi-loop.js for per-message pi runs. Telegram is
# excluded because the loop owns its own long-lived telegram-multi child
# (sole poller), and the per-pi-run mcp-bridge mustn't spawn a second one
# (409 Conflict on getUpdates). Outbound replies go through the
# telegram-out Pi extension instead, which uses Telegram's HTTP Bot API.
jq 'del(.mcpServers.telegram)' /home/deploy/.mcp.json \
  > /home/deploy/.mcp-shelly-pi.json
chown deploy:deploy /home/deploy/.mcp-shelly-pi.json
chmod 600 /home/deploy/.mcp-shelly-pi.json

# Pi extensions — npm install per extension dir. Pi runs .ts via jiti so
# source changes apply without a build, BUT each extension's own
# node_modules must exist on disk for jiti to resolve imports
# (@modelcontextprotocol/sdk in mcp-bridge, pg in telegram-out, etc).
# github + loop-guard are dep-free so far, install is a no-op there but
# keeps the pattern uniform. Run as deploy so file ownership is right.
# NOTE: this loop runs inside the unquoted heredoc on line 53, so any
# unescaped \$var would expand LOCALLY (where it's unset under set -u)
# instead of on the remote. Backslash-escape every shell var so it
# survives the heredoc and gets evaluated on hetzner-vps. Same convention
# as the \`for v in PG_PASS …\` loop above (which uses indirect \${!v}).
# Discover extensions from the filesystem instead of hardcoding the list,
# so adding a new pi-extensions/<name>/ doesn't require a deploy-script
# edit. Same heredoc-escape pattern as elsewhere in this block.
for ext_dir in /home/deploy/projects/dev-panel/infra/pi-extensions/*/; do
  if [ -f "\$ext_dir/package.json" ]; then
    su - deploy -c "cd \$ext_dir && /usr/bin/npm install --no-audit --no-fund --silent"
  fi
done

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

# Logrotate — keep /home/deploy/logs/*.log from blowing up the disk.
# Specifically forced after the 2026-05-08 incident where telegram-multi.log
# grew to 2.1 GB from a stderr EPIPE recursion.
install -o root -g root -m 0644 \
  /home/deploy/projects/dev-panel/infra/logrotate-agents.conf \
  /etc/logrotate.d/devpanel-agents

# Systemd units (worker + shelly + watchdog + relay + daily-restart + pi fallback).
# CRITICAL: shelly-switch.sh masks the off-mode unit by creating a symlink
# /etc/systemd/system/<unit> → /dev/null. A naive \`cp\` would overwrite the
# symlink with a real file, un-masking the unit and letting it be started.
# Inline check before each cp: skip if the destination is currently a
# symlink to /dev/null (mask).
#
# NOTE on heredoc escaping: this whole block runs inside the unquoted
# heredoc on line 53 so it can interpolate \${PG_PASS} etc. Anything we
# want evaluated on the REMOTE must be backslash-escaped. Originally I
# tried a function with nested \$(readlink "\$dest") and macOS bash 3.2
# choked on the nested double-quotes inside \$(); flat per-unit
# conditionals avoid that whole class of trap.
for unit in \\
  /home/deploy/projects/dev-panel/infra/devpanel-worker.service \\
  /home/deploy/projects/dev-panel/infra/shelly.service \\
  /home/deploy/projects/dev-panel/infra/shelly-pi.service \\
  /home/deploy/projects/dev-panel/infra/shelly-watchdog.service \\
  /home/deploy/projects/dev-panel/infra/shelly-watchdog.timer \\
  /home/deploy/projects/dev-panel/infra/shelly-relay.service \\
  /home/deploy/projects/dev-panel/infra/shelly-daily-restart.service \\
  /home/deploy/projects/dev-panel/infra/shelly-daily-restart.timer; do
  dest=/etc/systemd/system/\$(basename \$unit)
  if [ -L \$dest ] && [ \$(readlink \$dest) = /dev/null ]; then
    echo "(skipping install of \$dest — masked by shelly-switch.sh)"
    continue
  fi
  cp \$unit \$dest
done

# Quota-fallback switch script — Franck runs this when Claude Max is out.
install -o deploy -g deploy -m 0755 \
  /home/deploy/projects/dev-panel/scripts/shelly-switch.sh \
  /home/deploy/bin/shelly-switch.sh

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

# Mode-aware enable: shelly-switch.sh masks the off-mode shelly unit so a
# stray systemctl-start can't bring it back. Trying to \`enable\` a masked
# unit fails with non-zero. Loop individually, skipping masked. Same
# heredoc-escape pattern as the install_unit block above (no nested
# double-quotes inside \$()).
for u in devpanel-worker shelly.service shelly-watchdog.timer shelly-relay.service shelly-daily-restart.timer; do
  state=\$(systemctl is-enabled \$u 2>&1 || true)
  if [ \$state = masked ]; then
    echo "(skipping enable of \$u — masked by shelly-switch.sh)"
    continue
  fi
  systemctl enable \$u 2>/dev/null || true
done

systemctl restart devpanel-worker
systemctl restart shelly-relay.service
# Reload shelly only if it's running AND not masked.
shelly_state=\$(systemctl is-enabled shelly.service 2>/dev/null || true)
if [ \$shelly_state != masked ] && systemctl is-active --quiet shelly.service; then
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
