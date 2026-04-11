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

echo "=== Configuring SSH hardening ==="
sed -i 's/#PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd

echo "=== Configuring unattended upgrades ==="
apt-get install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

echo "=== Done ==="
echo "Next steps:"
echo "  1. Copy docker-compose.prod.yml to /home/deploy/dev-panel/"
echo "  2. Copy infra/traefik.yml to /home/deploy/dev-panel/traefik/traefik.yml"
echo "  3. Copy infra/dynamic.yml to /home/deploy/dev-panel/traefik/dynamic.yml"
echo "  4. Create /home/deploy/dev-panel/.env with GITHUB_TOKEN, ADMIN_API_KEY, ALLOWED_ORIGINS, NODE_ENV"
echo "  5. Login to ghcr.io: docker login ghcr.io -u franckbirba"
echo "  6. Run: cd /home/deploy/dev-panel && docker compose -f docker-compose.prod.yml up -d"
