#!/bin/bash
# ============================================================================
# init.sh — Idempotent .env file generation
# Usage:
#   bash infra/init.sh local       → creates .env
#   bash infra/init.sh production  → creates .env.production
#
# Precedence for each secret:
#   1. Shell env (from CI / GH secret) — wins when present and non-empty
#   2. Existing value in target file — preserved across re-runs
#   3. Freshly generated openssl hex (fallback)
# ============================================================================
set -euo pipefail

MODE="${1:-local}"
ENV_FILE="${MODE/local/.env}"
ENV_FILE="${ENV_FILE/production/.env.production}"

echo "🔧 Initializing $ENV_FILE..."

gen_secret() { openssl rand -hex 32; }

# Stage values BEFORE truncating $ENV_FILE
# (earlier versions used $() inside a heredoc — that bug regenerated
#  secrets because > truncates the file before $() runs)
stage() {
  local key="$1"
  local env_val="${!key:-}"
  if [ -n "$env_val" ]; then
    echo "$env_val"; return
  fi
  if [ -f "$ENV_FILE" ]; then
    local file_val
    file_val=$(grep "^${key}=" "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2-)
    if [ -n "$file_val" ]; then
      echo "$file_val"; return
    fi
  fi
  gen_secret
}

ADMIN_API_KEY_V=$(stage ADMIN_API_KEY)
AFFINE_DB_PASSWORD_V=$(stage AFFINE_DB_PASSWORD)
PLANE_DB_PASSWORD_V=$(stage PLANE_DB_PASSWORD)
PLANE_SECRET_KEY_V=$(stage PLANE_SECRET_KEY)
PLANE_MINIO_ROOT_PASSWORD_V=$(stage PLANE_MINIO_ROOT_PASSWORD)
PENPOT_SECRET_KEY_V=$(stage PENPOT_SECRET_KEY)
PENPOT_DB_PASSWORD_V=$(stage PENPOT_DB_PASSWORD)
PLANE_API_KEY_V=$(stage PLANE_API_KEY)

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
ADMIN_API_KEY=${ADMIN_API_KEY_V}
GITHUB_TOKEN=${GITHUB_TOKEN:-}

# AI/Memory
VOYAGE_API_KEY=${VOYAGE_API_KEY:-}

# Monitoring
ENABLE_MONITORING=true
ENABLE_BULLMQ=true
REDIS_HOST=redis
REDIS_PORT=6379

# Telegram (optional)
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-}

# AFFiNE
AFFINE_DB_PASSWORD=${AFFINE_DB_PASSWORD_V}
AFFINE_URL=http://affine:3010

# Agent memory (pgvector on the shared devpanel-postgres container)
PG_HOST=devpanel-postgres
PG_PORT=5432
PG_USER=affine
PG_PASSWORD=${AFFINE_DB_PASSWORD_V}
PG_DATABASE=agent_memory
AGENT_MEMORY_NAMESPACE=dev-panel
VOYAGE_MODEL=voyage-code-3

# Plane
PLANE_DB_PASSWORD=${PLANE_DB_PASSWORD_V}
PLANE_SECRET_KEY=${PLANE_SECRET_KEY_V}
PLANE_MINIO_ROOT_USER=plane
PLANE_MINIO_ROOT_PASSWORD=${PLANE_MINIO_ROOT_PASSWORD_V}
# REST API key the worker (and agents) use to read/write Plane work items.
# Preserved across re-runs by the stage() helper above; not auto-generated.
PLANE_API_KEY=${PLANE_API_KEY_V}

# Penpot
PENPOT_SECRET_KEY=${PENPOT_SECRET_KEY_V}
PENPOT_DB_PASSWORD=${PENPOT_DB_PASSWORD_V}
ENVEOF

# ── Generate htpasswd for Traefik (only in production) ──────────────────────

if [ "$MODE" = "production" ]; then
  HTPASSWD_FILE="infra/config/.htpasswd"
  if [ ! -f "$HTPASSWD_FILE" ]; then
    HTPASSWD_USER="${TRAEFIK_USER:-admin}"
    HTPASSWD_PASS="${TRAEFIK_PASS:-$(openssl rand -base64 12)}"
    mkdir -p infra/config
    echo "$HTPASSWD_USER:$(openssl passwd -apr1 "$HTPASSWD_PASS")" > "$HTPASSWD_FILE"
    echo "✓ Created $HTPASSWD_FILE (user: $HTPASSWD_USER, pass: $HTPASSWD_PASS)"
  fi
fi

echo "✅ Generated $ENV_FILE"
echo ""
echo "Next steps:"
echo "  1. Fill in missing values (GITHUB_TOKEN, TELEGRAM_BOT_TOKEN, etc.)"
echo "  2. Run: make local     (local dev)"
echo "       or: make deploy-all  (production)"
