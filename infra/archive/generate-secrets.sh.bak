#!/bin/bash
# ============================================================================
# GENERATE PRODUCTION SECRETS
# Usage: ./infra/generate-secrets.sh
# ============================================================================

set -euo pipefail

echo "🔐 Generating production secrets..."

# Check dependencies
if ! command -v openssl &> /dev/null; then
  echo "❌ openssl not found. Install with: brew install openssl (macOS) or apt install openssl (Linux)"
  exit 1
fi

if ! command -v htpasswd &> /dev/null; then
  echo "⚠️  htpasswd not found. Traefik auth will use default password."
  echo "   Install with: brew install httpd (macOS) or apt install apache2-utils (Linux)"
  HTPASSWD_AVAILABLE=false
else
  HTPASSWD_AVAILABLE=true
fi

# Generate secrets
ADMIN_API_KEY=$(openssl rand -hex 32)
DEFAULT_PASSWORD="changeme123"

if [ "$HTPASSWD_AVAILABLE" = true ]; then
  # Escape $ for docker-compose
  TRAEFIK_AUTH=$(htpasswd -nb admin "$DEFAULT_PASSWORD" | sed 's/\$/\$\$/g')
else
  TRAEFIK_AUTH="admin:\$\$apr1\$\$placeholder"
fi

# Prompt for domain
read -p "Enter your domain (e.g., devpanel.dev): " DOMAIN
read -p "Enter your email for Let's Encrypt: " ACME_EMAIL

# Create .env.production
cat > .env.production << EOF
# ============================================================================
# PRODUCTION ENVIRONMENT VARIABLES
# Generated on $(date)
# ============================================================================

# Node
NODE_ENV=production

# Domain
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}

# Security
ADMIN_API_KEY=${ADMIN_API_KEY}
ALLOWED_ORIGINS=https://devpanel.${DOMAIN}

# Traefik Dashboard Auth (username: admin, password: ${DEFAULT_PASSWORD})
TRAEFIK_AUTH=${TRAEFIK_AUTH}

# GitHub (ADD MANUALLY)
GITHUB_TOKEN=
# Create at: https://github.com/settings/tokens
# Required scopes: repo, read:org

# Monitoring
ENABLE_MONITORING=true
ENABLE_BULLMQ=true
REDIS_HOST=redis
REDIS_PORT=6379

# Alerts (OPTIONAL - Leave empty to disable)
SHELLY_TELEGRAM_WEBHOOK=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# External services (OPTIONAL - Leave empty if not monitoring)
PENPOT_URL=
AFFINE_URL=http://affine:3010

# AFFiNE database
AFFINE_DB_PASSWORD=$(openssl rand -hex 16)

# Plane
PLANE_DB_PASSWORD=$(openssl rand -hex 16)
PLANE_SECRET_KEY=$(openssl rand -hex 32)
PLANE_MINIO_ROOT_USER=plane
PLANE_MINIO_ROOT_PASSWORD=$(openssl rand -hex 16)
EOF

echo ""
echo "✅ Secrets generated in .env.production"
echo ""
echo "📋 Summary:"
echo "  • ADMIN_API_KEY: ${ADMIN_API_KEY}"
echo "  • DOMAIN: ${DOMAIN}"
echo "  • ACME_EMAIL: ${ACME_EMAIL}"
echo "  • Traefik login: admin / ${DEFAULT_PASSWORD}"
echo ""
echo "⚠️  IMPORTANT: Add manually in .env.production:"
echo "  1. GITHUB_TOKEN (get from https://github.com/settings/tokens)"
echo ""
echo "📝 Optional (for Telegram alerts):"
echo "  2. SHELLY_TELEGRAM_WEBHOOK"
echo "  3. TELEGRAM_BOT_TOKEN"
echo "  4. TELEGRAM_CHAT_ID"
echo ""
echo "🌐 DNS Configuration (Cloudflare):"
echo "  Add these A records pointing to your VPS IP:"
echo "    • devpanel.${DOMAIN}"
echo "    • status.${DOMAIN}"
echo "    • queues.${DOMAIN}"
echo "    • traefik.${DOMAIN}"
echo ""
echo "🚀 Next steps:"
echo "  1. Configure DNS on Cloudflare"
echo "  2. Edit .env.production and add GITHUB_TOKEN"
echo "  3. Run: ./infra/deploy-prod.sh"
echo ""
