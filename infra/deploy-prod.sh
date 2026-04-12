#!/bin/bash
# ============================================================================
# PRODUCTION DEPLOYMENT SCRIPT
# Deploys dev-panel to Hetzner services node (10.0.0.2)
# ============================================================================

set -euo pipefail

SERVICES_NODE="77.42.46.87"
DEPLOY_USER="deploy"
PROJECT_DIR="/home/deploy/dev-panel"
SSH_KEY="$HOME/.ssh/devpanel_deploy"

# SSH command wrapper
SSH_CMD="ssh -i $SSH_KEY"
SCP_CMD="scp -i $SSH_KEY"

echo "🚀 Deploying dev-panel to production..."

# ============================================================================
# 1. Pre-flight checks
# ============================================================================
echo "🔍 Running pre-flight checks..."

if [ ! -f ".env.production" ]; then
  echo "❌ .env.production not found. Copy from .env.production template and fill in secrets."
  exit 1
fi

if ! grep -q "ADMIN_API_KEY=." .env.production; then
  echo "❌ ADMIN_API_KEY not set in .env.production"
  exit 1
fi

# Skip DOMAIN check (can be empty for apex domain)

echo "✓ Pre-flight checks passed"

# ============================================================================
# 2. Build dashboard locally
# ============================================================================
echo "📦 Building dashboard..."
npm ci
npm run build

echo "✓ Dashboard built"

# ============================================================================
# 3. Deploy files to server
# ============================================================================
echo "📤 Deploying files to $SERVICES_NODE..."

# Create project directory
${SSH_CMD} ${DEPLOY_USER}@${SERVICES_NODE} "mkdir -p ${PROJECT_DIR}/{storage,traefik}"

# Deploy application code
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .env \
  --exclude storage \
  ./ ${DEPLOY_USER}@${SERVICES_NODE}:${PROJECT_DIR}/

# Deploy .env
${SCP_CMD} .env.production ${DEPLOY_USER}@${SERVICES_NODE}:${PROJECT_DIR}/.env

# Deploy Docker Compose files
${SCP_CMD} infra/docker-compose.yml ${DEPLOY_USER}@${SERVICES_NODE}:${PROJECT_DIR}/
${SCP_CMD} infra/docker-compose.monitoring.yml ${DEPLOY_USER}@${SERVICES_NODE}:${PROJECT_DIR}/

# Deploy Dockerfile
${SCP_CMD} Dockerfile ${DEPLOY_USER}@${SERVICES_NODE}:${PROJECT_DIR}/

echo "✓ Files deployed"

# ============================================================================
# 4. Skip npm install - use Docker build instead
# ============================================================================
echo "📦 Skipping npm install (using Docker build)..."

# ============================================================================
# 5. Start services
# ============================================================================
echo "🐳 Starting Docker services..."

${SSH_CMD} ${DEPLOY_USER}@${SERVICES_NODE} << 'EOF'
cd /home/deploy/dev-panel

# Use docker compose (v2 plugin) instead of docker-compose
alias docker-compose='docker compose'

# Pull images
docker compose pull

# Build DevPanel image
docker compose build devpanel

# Start main stack
docker compose up -d

# Start monitoring stack
docker compose -f docker-compose.monitoring.yml up -d

# Wait for services to be healthy
sleep 10

# Check status
docker compose ps
docker compose -f docker-compose.monitoring.yml ps
EOF

echo "✓ Services started"

# ============================================================================
# 6. Setup cron jobs
# ============================================================================
echo "⏰ Setting up cron jobs..."

${SSH_CMD} ${DEPLOY_USER}@${SERVICES_NODE} << 'EOF'
# Install backup cron
(crontab -l 2>/dev/null; echo "0 3 * * * /home/deploy/dev-panel/infra/backup-cron.sh >> /home/deploy/logs/backup.log 2>&1") | crontab -

# Create logs directory
mkdir -p /home/deploy/logs

echo "✓ Cron jobs installed"
EOF

# ============================================================================
# 7. Verify deployment
# ============================================================================
echo "🧪 Verifying deployment..."

sleep 5

# Check health
HEALTH_STATUS=$(${SSH_CMD} ${DEPLOY_USER}@${SERVICES_NODE} "curl -sf http://localhost:3030/api/health" || echo "failed")

if [ "$HEALTH_STATUS" == "failed" ]; then
  echo "❌ Health check failed!"
  echo "Check logs with: ssh ${DEPLOY_USER}@${SERVICES_NODE} 'docker logs devpanel-api'"
  exit 1
fi

echo "✓ Health check passed"

# ============================================================================
# 8. Display access URLs
# ============================================================================
DOMAIN=$(grep "^DOMAIN=" .env.production | cut -d= -f2)

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Access URLs:"
echo "  • DevPanel:     https://devpanel.${DOMAIN}"
echo "  • Traefik:      https://traefik.${DOMAIN}"
echo "  • Uptime Kuma:  https://status.${DOMAIN}"
echo "  • Bull Board:   https://queues.${DOMAIN}"
echo ""
echo "Next steps:"
echo "  1. Configure DNS A records for the above domains"
echo "  2. Access Uptime Kuma and complete initial setup"
echo "  3. Import monitors from /home/deploy/dev-panel/infra/uptime-kuma-config.json"
echo "  4. Test Telegram alerts"
echo ""
echo "Useful commands:"
echo "  • View logs:     ssh ${DEPLOY_USER}@${SERVICES_NODE} 'docker logs -f devpanel-api'"
echo "  • Restart:       ssh ${DEPLOY_USER}@${SERVICES_NODE} 'cd ${PROJECT_DIR} && docker-compose restart'"
echo "  • Health check:  curl https://devpanel.${DOMAIN}/api/health"
echo ""
