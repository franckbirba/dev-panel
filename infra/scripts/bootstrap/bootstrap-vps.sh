#!/bin/bash
# ============================================================================
# BOOTSTRAP VPS — Install Docker, Node.js, setup deploy user
# Run once before deploy-prod.sh
# ============================================================================

set -euo pipefail

VPS_IP="${1:-77.42.46.87}"
SSH_KEY="$HOME/.ssh/devpanel_deploy"

echo "🚀 Bootstrapping VPS ${VPS_IP}..."

# Install as root first
ssh -i "$SSH_KEY" deploy@${VPS_IP} << 'EOF'
# Switch to root for installations
sudo bash << 'ROOTEOF'

# Update system
apt-get update
apt-get upgrade -y

# Install Docker
if ! command -v docker &> /dev/null; then
  echo "📦 Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  usermod -aG docker deploy
  echo "✓ Docker installed"
else
  echo "✓ Docker already installed"
fi

# Install Node.js 22
if ! command -v node &> /dev/null; then
  echo "📦 Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  echo "✓ Node.js installed"
else
  echo "✓ Node.js already installed"
fi

# Install additional tools
apt-get install -y git curl wget htop

ROOTEOF

echo "✓ System packages installed"

# Verify installations
echo ""
echo "📊 Installed versions:"
docker --version
node --version
npm --version

EOF

echo ""
echo "✅ VPS bootstrap complete!"
echo ""
echo "Next steps:"
echo "  1. Logout and login again (for docker group):"
echo "     ssh -i $SSH_KEY deploy@${VPS_IP} 'newgrp docker'"
echo ""
echo "  2. Run deployment:"
echo "     ./infra/deploy-prod.sh"
echo ""
