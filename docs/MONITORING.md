# Monitoring & Alerting

Complete monitoring solution for dev-panel with Uptime Kuma, BullMQ Dead Letter Queue, and Telegram alerts via Shelly.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         MONITORING STACK                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │ Uptime Kuma  │  │   BullMQ     │  │    Redis     │        │
│  │  (HTTP/TCP)  │  │   Workers    │  │   Backend    │        │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘        │
│         │                  │                  │                 │
│         └──────────────────┼──────────────────┘                 │
│                            │                                     │
│                    ┌───────▼────────┐                           │
│                    │  Alert Manager │                           │
│                    │   (batching)   │                           │
│                    └───────┬────────┘                           │
│                            │                                     │
│                    ┌───────▼────────┐                           │
│                    │     Shelly     │                           │
│                    │   (Telegram)   │                           │
│                    └────────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Uptime Kuma (Self-hosted)
- **Purpose**: HTTP/TCP/WebSocket monitoring
- **URL**: `http://status.devpanel.local` or `http://10.0.0.2:3001`
- **Features**:
  - Monitors API endpoints, databases, external services
  - Built-in alerting to Telegram, Discord, Slack, etc.
  - Status page generation
  - Historical uptime tracking

**Monitors configured:**
- DevPanel API (`/api/health`)
- DevPanel Dashboard (`/dashboard`)
- BullMQ queues (`/api/health/queues`)
- Redis (TCP port check)
- Penpot API
- AFFiNE API
- Agent node SSH (10.0.0.3:22)
- Agent node process health

### 2. BullMQ Dead Letter Queue
- **Purpose**: Capture and retry failed async jobs
- **URL**: `http://queues.devpanel.local` or `http://10.0.0.2:3002` (Bull Board)
- **Features**:
  - Auto-retry with exponential backoff (3 attempts)
  - Failed jobs moved to DLQ after exhaustion
  - Manual retry from DLQ
  - Job history tracking

**Queues:**
- `devpanel:tickets` — Ticket processing
- `devpanel:github_sync` — GitHub sync jobs
- `devpanel:notifications` — Notification dispatch
- `devpanel:dead_letter` — Failed jobs (DLQ)

### 3. Alert Manager (Shelly → Telegram)
- **Purpose**: Batch and send critical alerts to Telegram
- **Features**:
  - Deduplication (5-minute window)
  - Severity levels: `critical`, `warning`, `info`
  - Auto-flush every 60s (critical alerts sent immediately)
  - Markdown formatting

**Alert triggers:**
- System down/degraded
- Component failures (database, storage, etc.)
- High memory usage (>500MB heap)
- BullMQ job failures after max retries
- Queue stalls

## Setup

### Prerequisites
```bash
export ADMIN_API_KEY="your-secret-admin-key"
export SHELLY_TELEGRAM_WEBHOOK="https://your-shelly-instance/webhook/telegram"
export TELEGRAM_BOT_TOKEN="your-telegram-bot-token"
export TELEGRAM_CHAT_ID="your-chat-id"
```

### Deploy
```bash
cd /Users/franckbirba/DEV/dev-panel
./infra/monitoring-setup.sh
```

### Manual setup (if script fails)
```bash
# 1. Deploy Docker stack
scp infra/docker-compose.monitoring.yml deploy@10.0.0.2:/home/deploy/dev-panel/
ssh deploy@10.0.0.2 'cd /home/deploy/dev-panel && docker-compose -f docker-compose.monitoring.yml up -d'

# 2. Enable monitoring on DevPanel
ssh deploy@10.0.0.2 << 'EOF'
cat >> /home/deploy/dev-panel/.env << 'ENVFILE'
ENABLE_MONITORING=true
ENABLE_BULLMQ=true
REDIS_HOST=redis
REDIS_PORT=6379
SHELLY_TELEGRAM_WEBHOOK=https://your-shelly/webhook
ADMIN_API_KEY=your-admin-key
ENVFILE
docker-compose restart devpanel
EOF

# 3. Configure Uptime Kuma
# Access http://status.devpanel.local
# Complete initial setup
# Import monitors from infra/uptime-kuma-config.json
```

## API Endpoints

### Health Checks
```bash
# Basic health
curl http://10.0.0.2:3030/api/health

# Detailed health (admin only)
curl http://10.0.0.2:3030/api/health/detailed \
  -H "X-Admin-Key: $ADMIN_API_KEY"

# Queue health
curl http://10.0.0.2:3030/api/health/queues \
  -H "X-Admin-Key: $ADMIN_API_KEY"

# Prometheus metrics
curl http://10.0.0.2:3030/api/metrics
```

### Dead Letter Queue
```bash
# List failed jobs
curl http://10.0.0.2:3030/api/admin/dlq \
  -H "X-Admin-Key: $ADMIN_API_KEY"

# Retry a failed job
curl -X POST http://10.0.0.2:3030/api/admin/dlq/{jobId}/retry \
  -H "X-Admin-Key: $ADMIN_API_KEY"
```

## Alert Examples

### Critical Alert (sent immediately)
```json
{
  "severity": "critical",
  "message": "DevPanel API is down",
  "component": "api",
  "timestamp": "2026-04-12T15:30:00Z"
}
```

**Telegram output:**
```
🚨 CRITICAL

Component: api
Message: DevPanel API is down
Time: 2026-04-12T15:30:00Z
```

### Warning Alert (batched)
```json
{
  "severity": "warning",
  "message": "High memory usage detected",
  "component": "memory",
  "metadata": {
    "heap_used_mb": 512,
    "heap_total_mb": 1024
  },
  "timestamp": "2026-04-12T15:30:00Z"
}
```

## Troubleshooting

### Uptime Kuma not accessible
```bash
ssh deploy@10.0.0.2
docker ps | grep uptime-kuma
docker logs uptime-kuma
```

### BullMQ jobs stuck
```bash
# Check queue health
curl http://10.0.0.2:3030/api/health/queues -H "X-Admin-Key: $ADMIN_API_KEY"

# Access Bull Board
open http://queues.devpanel.local

# Restart Redis
ssh deploy@10.0.0.2 'docker-compose -f docker-compose.monitoring.yml restart redis'
```

### Alerts not sent
```bash
# Check alert manager logs
ssh deploy@10.0.0.2
docker logs devpanel | grep AlertManager

# Test Shelly webhook
curl -X POST $SHELLY_TELEGRAM_WEBHOOK \
  -H "Content-Type: application/json" \
  -d '{"text": "Test alert", "parse_mode": "Markdown"}'

# Check env vars
ssh deploy@10.0.0.2 'cat /home/deploy/dev-panel/.env | grep SHELLY'
```

### Dead Letter Queue filling up
```bash
# List failed jobs
curl http://10.0.0.2:3030/api/admin/dlq -H "X-Admin-Key: $ADMIN_API_KEY"

# Retry all (dangerous!)
for job_id in $(curl -s http://10.0.0.2:3030/api/admin/dlq -H "X-Admin-Key: $ADMIN_API_KEY" | jq -r '.jobs[].id'); do
  curl -X POST http://10.0.0.2:3030/api/admin/dlq/$job_id/retry -H "X-Admin-Key: $ADMIN_API_KEY"
done
```

## Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `ENABLE_MONITORING` | Enable monitoring features | `false` | No |
| `ENABLE_BULLMQ` | Enable BullMQ queue monitoring | `false` | No |
| `REDIS_HOST` | Redis hostname | `localhost` | Yes (if BullMQ enabled) |
| `REDIS_PORT` | Redis port | `6379` | No |
| `SHELLY_TELEGRAM_WEBHOOK` | Shelly webhook URL for Telegram | - | Yes (if alerts enabled) |
| `ADMIN_API_KEY` | Admin API key for protected endpoints | - | Yes (production) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (Uptime Kuma) | - | No |
| `TELEGRAM_CHAT_ID` | Telegram chat ID (Uptime Kuma) | - | No |

## Best Practices

1. **Set ADMIN_API_KEY in production** — Never expose admin endpoints without auth
2. **Monitor the monitors** — Set up Uptime Kuma notifications to alert on monitor failures
3. **Review DLQ weekly** — Failed jobs accumulate; investigate root causes
4. **Tune alert thresholds** — Adjust memory/queue limits to avoid false positives
5. **Test failover** — Simulate service failures to verify alerts work

## Integration with Existing Infra

The monitoring stack runs on the **services node (10.0.0.2)** alongside Traefik and DevPanel API. It monitors:

- **Services node**: API, dashboard, queues, Redis
- **Agent node**: SSH, OpenClaw/Claude Code process
- **External services**: Penpot, AFFiNE

All monitoring data stays local (no external dependencies except Telegram for alerts).
