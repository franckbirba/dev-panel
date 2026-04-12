#!/bin/bash
set -euo pipefail

echo "=== Updating system ==="
apt-get update && apt-get upgrade -y

echo "=== Installing Docker ==="
curl -fsSL https://get.docker.com | sh

echo "=== Creating deploy user ==="
useradd -m -s /bin/bash -G docker deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
usermod -aG docker deploy

echo "=== Setting up project directory ==="
mkdir -p /home/deploy/dev-panel/storage
mkdir -p /home/deploy/dev-panel/traefik
chown -R deploy:deploy /home/deploy/dev-panel

echo "=== Configuring firewall ==="
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "=== Configuring SSH hardening ==="
sed -i '/^#\?PermitRootLogin/c\PermitRootLogin no' /etc/ssh/sshd_config
sed -i '/^#\?PasswordAuthentication/c\PasswordAuthentication no' /etc/ssh/sshd_config
systemctl restart sshd

echo "=== Configuring unattended upgrades ==="
apt-get install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

echo "=== Done ==="
echo ""
echo "=== ARCHITECTURE: 2 NODES on private network ==="
echo "  10.0.0.2 (services) — Docker: Traefik, AFFiNE, Penpot, DevPanel, BullMQ, PostgreSQL"
echo "  10.0.0.3 (agents)   — OpenClaw + Claude Code (Shelly hub + all agents)"
echo ""
echo "=== SERVICES NODE (10.0.0.2) ==="
echo "  1. Copy docker-compose.prod.yml to /home/deploy/dev-panel/"
echo "  2. Copy infra/traefik.yml to /home/deploy/dev-panel/traefik/traefik.yml"
echo "  3. Copy infra/dynamic.yml to /home/deploy/dev-panel/traefik/dynamic.yml"
echo "  4. Create /home/deploy/dev-panel/.env (see .env.example)"
echo "  5. Login to ghcr.io: docker login ghcr.io -u franckbirba"
echo "  6. Run: cd /home/deploy/dev-panel && docker compose -f docker-compose.prod.yml up -d"
echo ""
echo "=== AGENTS NODE (10.0.0.3) ==="
echo "  1. Install Claude Code: npm install -g @anthropic-ai/claude-code"
echo "  2. Install OpenClaw: npm install -g openclaw"
echo "  3. Provision Claude config:"
echo "     mkdir -p ~/.claude && cp infra/claude/settings.json ~/.claude/"
echo "     cp infra/claude/mcp.json ~/dev-panel/.mcp.json"
echo "  4. Set env vars in ~/.bashrc or ~/.env:"
echo "     export AFFINE_API_TOKEN=ut_..."
echo "     export AFFINE_WORKSPACE_ID=..."
echo "     export ANTHROPIC_API_KEY=..."
echo "  5. Authenticate: claude auth login"
echo "  6. Verify connectivity: curl http://10.0.0.2:3010/info (AFFiNE)"
echo "     curl http://10.0.0.2:3030/api/health (DevPanel)"
