#!/bin/bash
# ============================================================================
# MONITORING STACK SETUP
# Deploy Uptime Kuma, BullMQ, Redis, and configure alerts
# ============================================================================

set -euo pipefail

SERVICES_NODE="10.0.0.2"
ADMIN_KEY="${ADMIN_API_KEY:-}"
TELEGRAM_WEBHOOK="${SHELLY_TELEGRAM_WEBHOOK:-}"

echo "🚀 Setting up monitoring stack..."

# ============================================================================
# 1. Deploy monitoring services
# ============================================================================
echo "📦 Deploying Uptime Kuma + Redis + Bull Board..."
scp infra/docker-compose.monitoring.yml deploy@${SERVICES_NODE}:/home/deploy/dev-panel/
ssh deploy@${SERVICES_NODE} << 'EOF'
cd /home/deploy/dev-panel
docker-compose -f docker-compose.monitoring.yml up -d
echo "✓ Monitoring stack deployed"
EOF

# ============================================================================
# 2. Configure Uptime Kuma monitors
# ============================================================================
echo "⚙️  Configuring Uptime Kuma monitors..."
cat > /tmp/kuma-setup.sh << 'SETUP_SCRIPT'
#!/bin/bash
# Wait for Uptime Kuma to be ready
while ! curl -sf http://localhost:3001 > /dev/null; do
  echo "Waiting for Uptime Kuma..."
  sleep 5
done

# Create monitors via API (requires initial setup first)
# Manual step: Access http://status.devpanel.local and complete initial setup
# Then use API to bulk import monitors from uptime-kuma-config.json

echo "✓ Uptime Kuma ready. Complete initial setup at http://status.devpanel.local"
echo "Then import monitors from: /home/deploy/dev-panel/uptime-kuma-config.json"
SETUP_SCRIPT

scp /tmp/kuma-setup.sh deploy@${SERVICES_NODE}:/home/deploy/dev-panel/
scp infra/uptime-kuma-config.json deploy@${SERVICES_NODE}:/home/deploy/dev-panel/
ssh deploy@${SERVICES_NODE} "bash /home/deploy/dev-panel/kuma-setup.sh"

# ============================================================================
# 3. Enable monitoring on DevPanel API
# ============================================================================
echo "🔌 Enabling monitoring features..."
ssh deploy@${SERVICES_NODE} << EOF
cat >> /home/deploy/dev-panel/.env << 'ENVFILE'
# Monitoring
ENABLE_MONITORING=true
ENABLE_BULLMQ=true
REDIS_HOST=redis
REDIS_PORT=6379
SHELLY_TELEGRAM_WEBHOOK=${TELEGRAM_WEBHOOK}
ADMIN_API_KEY=${ADMIN_KEY}
ENVFILE

# Restart DevPanel to pick up monitoring
docker-compose restart devpanel
echo "✓ DevPanel monitoring enabled"
EOF

# ============================================================================
# 4. Test alerts
# ============================================================================
echo "🧪 Testing alert system..."
curl -X POST http://${SERVICES_NODE}:3030/api/health/test-alert \
  -H "X-Admin-Key: ${ADMIN_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "severity": "info",
    "message": "Monitoring stack deployed successfully",
    "component": "monitoring"
  }' || echo "⚠️  Alert test failed (endpoint may not exist yet)"

# ============================================================================
# 5. Display access URLs
# ============================================================================
echo ""
echo "✅ Monitoring stack deployed!"
echo ""
echo "Access points:"
echo "  • Uptime Kuma:  http://status.devpanel.local (or http://${SERVICES_NODE}:3001)"
echo "  • Bull Board:   http://queues.devpanel.local (or http://${SERVICES_NODE}:3002)"
echo "  • Health API:   http://${SERVICES_NODE}:3030/api/health/detailed"
echo "  • Metrics:      http://${SERVICES_NODE}:3030/api/metrics"
echo "  • DLQ:          http://${SERVICES_NODE}:3030/api/admin/dlq"
echo ""
echo "Next steps:"
echo "  1. Access Uptime Kuma and complete initial setup"
echo "  2. Import monitors from /home/deploy/dev-panel/uptime-kuma-config.json"
echo "  3. Configure Telegram bot token and chat ID in Uptime Kuma"
echo "  4. Test alerts with: curl http://${SERVICES_NODE}:3030/api/admin/test-alert -H 'X-Admin-Key: ${ADMIN_KEY}'"
echo ""
