#!/bin/bash
# ============================================================================
# Generate .env file for production deployment
# Run on server: bash infra/gen-env.sh
# ============================================================================
set -euo pipefail

ENV_FILE="${1:-.env}"
echo "Generating $ENV_FILE..."

# Helper: generate random hex secret
gen_secret() { openssl rand -hex 32; }

# Helper: read existing value or generate new
existing_or_new() {
  local key="$1"
  local existing=""
  if [ -f "$ENV_FILE" ]; then
    existing=$(grep "^${key}=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
  fi
  if [ -n "$existing" ] && [ "$existing" != "\$${key}" ]; then
    echo "$existing"
  else
    gen_secret
  fi
}

# Helper: read existing value (no fallback)
existing_value() {
  local key="$1"
  if [ -f "$ENV_FILE" ]; then
    grep "^${key}=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true
  fi
}

# Generate htpasswd for Traefik
gen_htpasswd() {
  local user="${1:-admin}"
  local pass="${2:-$(openssl rand -base64 12)}"
  echo "  Traefik dashboard: $user / $pass" >&2
  # For docker-compose .env, $ must be doubled to $$
  htpasswd -nbB "$user" "$pass" | sed 's/\$/\$\$/g'
}

cat > "$ENV_FILE" << ENVEOF
# ============================================================================
# PRODUCTION ENVIRONMENT — Generated $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# DO NOT COMMIT THIS FILE
# Regenerate with: bash infra/gen-env.sh
# ============================================================================

# Node
NODE_ENV=production
DOMAIN=devpanel.dev
ACME_EMAIL=franckbirba@gmail.com

# Security
ADMIN_API_KEY=$(existing_or_new ADMIN_API_KEY)
ALLOWED_ORIGINS=https://devpanl.dev

# Traefik Dashboard Auth
TRAEFIK_AUTH=$(existing_value TRAEFIK_AUTH)

# GitHub
GITHUB_TOKEN=$(existing_value GITHUB_TOKEN)

# Monitoring
ENABLE_MONITORING=true
ENABLE_BULLMQ=true
REDIS_HOST=redis
REDIS_PORT=6379

# Telegram
TELEGRAM_BOT_TOKEN=$(existing_value TELEGRAM_BOT_TOKEN)
TELEGRAM_CHAT_ID=$(existing_value TELEGRAM_CHAT_ID)

# External services
PENPOT_URL=
AFFINE_URL=http://affine:3010

# AFFiNE
AFFINE_DB_PASSWORD=$(existing_or_new AFFINE_DB_PASSWORD)

# Plane
PLANE_DB_PASSWORD=$(existing_or_new PLANE_DB_PASSWORD)
PLANE_SECRET_KEY=$(existing_or_new PLANE_SECRET_KEY)
PLANE_MINIO_ROOT_USER=${PLANE_MINIO_ROOT_USER:-plane}
PLANE_MINIO_ROOT_PASSWORD=$(existing_or_new PLANE_MINIO_ROOT_PASSWORD)

# Penpot
PENPOT_SECRET_KEY=$(existing_or_new PENPOT_SECRET_KEY)
PENPOT_DB_PASSWORD=$(existing_or_new PENPOT_DB_PASSWORD)
ENVEOF

echo "✓ Generated $ENV_FILE"
echo "  Review and fill in any empty values (GITHUB_TOKEN, TELEGRAM_BOT_TOKEN, etc.)"
