#!/bin/bash
# ============================================================================
# init.sh — Idempotent .env file generation
# Usage:
#   bash infra/init.sh local       → creates .env
#   bash infra/init.sh production  → creates .env.production
# ============================================================================
set -euo pipefail

MODE="${1:-local}"
ENV_FILE="${MODE/local/.env}"
ENV_FILE="${ENV_FILE/production/.env.production}"

echo "🔧 Initializing $ENV_FILE..."

# ── Helpers ─────────────────────────────────────────────────────────────────

gen_secret() { openssl rand -hex 32; }

# Read existing value or generate new (preserves secrets on re-init)
existing_or_new() {
  local key="$1"
  if [ -f "$ENV_FILE" ]; then
    grep "^${key}=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- || gen_secret
  else
    gen_secret
  fi
}

# ── Generate .env ───────────────────────────────────────────────────────────

cat > "$ENV_FILE" << ENVEOF
# ============================================================================
# DEVPANEL ENVIRONMENT — Generated $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# Mode: $MODE
# DO NOT COMMIT THIS FILE
# ============================================================================

# Core
NODE_ENV=${MODE}
DOMAIN=devpanl.dev
ACME_EMAIL=franckbirba@gmail.com
ALLOWED_ORIGINS=https://devpanl.dev

# Security
ADMIN_API_KEY=$(existing_or_new ADMIN_API_KEY)
GITHUB_TOKEN=${GITHUB_TOKEN:-}

# Monitoring
ENABLE_MONITORING=true
ENABLE_BULLMQ=true
REDIS_HOST=redis
REDIS_PORT=6379

# Telegram (optional)
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-}

# AFFiNE
AFFINE_DB_PASSWORD=$(existing_or_new AFFINE_DB_PASSWORD)
AFFINE_URL=http://affine:3010

# Plane
PLANE_DB_PASSWORD=$(existing_or_new PLANE_DB_PASSWORD)
PLANE_SECRET_KEY=$(existing_or_new PLANE_SECRET_KEY)
PLANE_MINIO_ROOT_USER=plane
PLANE_MINIO_ROOT_PASSWORD=$(existing_or_new PLANE_MINIO_ROOT_PASSWORD)

# Penpot
PENPOT_SECRET_KEY=$(existing_or_new PENPOT_SECRET_KEY)
PENPOT_DB_PASSWORD=$(existing_or_new PENPOT_DB_PASSWORD)
ENVEOF

# ── Generate htpasswd for Traefik (only in production) ──────────────────────

if [ "$MODE" = "production" ]; then
  HTPASSWD_FILE="infra/.htpasswd"
  if [ ! -f "$HTPASSWD_FILE" ]; then
    HTPASSWD_USER="${TRAEFIK_USER:-admin}"
    HTPASSWD_PASS="${TRAEFIK_PASS:-$(openssl rand -base64 12)}"
    echo "$HTPASSWD_USER:$(openssl passwd -apr1 "$HTPASSWD_PASS")" > "$HTPASSWD_FILE"
    echo "✓ Created $HTPASSWD_FILE (user: $HTPASSWD_USER, pass: $HTPASSWD_PASS)"
  fi
fi

# ── Post-init instructions ──────────────────────────────────────────────────

echo "✅ Generated $ENV_FILE"
echo ""
echo "Next steps:"
echo "  1. Fill in missing values (GITHUB_TOKEN, TELEGRAM_BOT_TOKEN, etc.)"
echo "  2. Run: make local     (local dev)"
echo "       or: make deploy-all  (production)"
