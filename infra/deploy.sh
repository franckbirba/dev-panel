#!/bin/bash
# ============================================================================
# DEPLOY — Single script to deploy the entire infrastructure
# Usage: ./infra/deploy.sh [stack...]
#   No args = deploy everything
#   Args    = deploy specific stacks (core, plane, penpot, monitoring)
# ============================================================================
set -euo pipefail

HOST="${VPS_HOST:-77.42.46.87}"
USER="${DEPLOY_USER:-deploy}"
DIR="/home/deploy/dev-panel"
KEY="${SSH_KEY:-$HOME/.ssh/devpanel_deploy}"

SSH="ssh -i $KEY -o ConnectTimeout=10"
SCP="scp -i $KEY"

# ── Parse args ──────────────────────────────────────────────────────────────
STACKS="${@:-all}"
deploy_stack() { [[ "$STACKS" == "all" ]] || [[ "$STACKS" == *"$1"* ]]; }

echo "🚀 Deploying to $HOST..."
echo "   Stacks: $STACKS"
echo ""

# ── 1. Pre-flight ───────────────────────────────────────────────────────────
echo "🔍 Pre-flight checks..."

$SSH $USER@$HOST "docker info > /dev/null 2>&1" || { echo "❌ Docker not reachable on $HOST"; exit 1; }

# Ensure .env exists on server
$SSH $USER@$HOST "test -f $DIR/.env" || {
  echo "❌ No .env on server. Run GitHub Actions deploy first, or create manually."
  exit 1
}

echo "✓ Server reachable, .env present"

# ── 2. Sync files ──────────────────────────────────────────────────────────
echo "📤 Syncing files..."

$SSH $USER@$HOST "mkdir -p $DIR/nginx $DIR/traefik"

# Compose files
$SCP infra/docker-compose.yml         $USER@$HOST:$DIR/
$SCP infra/docker-compose.plane.yml   $USER@$HOST:$DIR/
$SCP infra/docker-compose.penpot.yml  $USER@$HOST:$DIR/
$SCP infra/docker-compose.monitoring.yml $USER@$HOST:$DIR/

# Traefik
$SCP infra/traefik.yml  $USER@$HOST:$DIR/traefik/
$SCP infra/dynamic.yml  $USER@$HOST:$DIR/traefik/

# Nginx SPA config
$SCP infra/nginx/spa.conf $USER@$HOST:$DIR/nginx/

# Dockerfile
$SCP Dockerfile $USER@$HOST:$DIR/

echo "✓ Files synced"

# ── 3. Deploy stacks ──────────────────────────────────────────────────────
echo "🐳 Starting stacks..."

if deploy_stack "core"; then
  echo "  → core (traefik, redis, devpanel, postgres, affine)..."
  $SSH $USER@$HOST "cd $DIR && docker compose pull && docker compose build devpanel && docker compose up -d --remove-orphans"
fi

if deploy_stack "plane"; then
  echo "  → plane (web, admin, api, worker, minio, db)..."
  $SSH $USER@$HOST "cd $DIR && docker compose -f docker-compose.plane.yml up -d --remove-orphans"
fi

if deploy_stack "penpot"; then
  echo "  → penpot (frontend, backend, exporter, db)..."
  $SSH $USER@$HOST "cd $DIR && docker compose -f docker-compose.penpot.yml up -d --remove-orphans"
fi

if deploy_stack "monitoring"; then
  echo "  → monitoring (uptime-kuma, bull-board, monitors)..."
  $SSH $USER@$HOST "cd $DIR && docker compose -f docker-compose.monitoring.yml up -d --remove-orphans"
fi

echo "✓ Stacks started"

# ── 4. Verify ──────────────────────────────────────────────────────────────
echo "🧪 Verifying..."
sleep 10

$SSH $USER@$HOST "cd $DIR && docker compose ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null | head -30"

echo ""
echo "✅ Deploy complete"
echo ""
echo "URLs:"
echo "  • DevPanel:     https://devpanl.dev"
echo "  • AFFiNE:       https://affine.devpanl.dev"
echo "  • Plane:        https://plane.devpanl.dev"
echo "  • Penpot:       https://penpot.devpanl.dev"
echo "  • Traefik:      https://traefik.devpanl.dev"
echo "  • Status:       https://status.devpanl.dev"
echo "  • Queues:       https://queues.devpanl.dev"
echo "  • MinIO:        https://minio.devpanl.dev"
