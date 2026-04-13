---
name: stack-status
description: Check status and health of all dev-panel stack services
---

# Stack Status & Health Check

Quick overview of all running services in the dev-panel infrastructure.

## Service Groups

### Core Infrastructure
- Traefik (reverse proxy)
- Redis (BullMQ + Plane)
- PostgreSQL (AFFiNE + Plane DBs)

### Applications
- DevPanel API
- Plane (7 containers: web, admin, space, live, api, worker, beat)
- AFFiNE (+ migration job)
- Penpot (frontend, backend, exporter)

### Storage
- MinIO (S3-compatible for Plane uploads)

### Monitoring
- Grafana
- Prometheus
- Loki
- cAdvisor
- Node Exporter

## Quick Status (Using Makefile)

```bash
# From project root
make status  # Runs comprehensive status check
```

## Manual Status Check

```bash
#!/bin/bash

echo "=== CONTAINER STATUS ==="
docker ps --filter "network=devpanel_net" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | head -30

echo -e "\n=== DOCKER COMPOSE PROFILE STATUS ==="
docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Service}}"

echo -e "\n=== HEALTH CHECKS ==="
docker ps --filter "health=unhealthy" --format "🔴 {{.Names}}: {{.Status}}"
docker ps --filter "health=healthy" --format "✅ {{.Names}}"

echo -e "\n=== DISK USAGE ==="
docker system df

echo -e "\n=== VOLUME USAGE ==="
docker volume ls --filter "label=com.docker.compose.project=dev-panel" --format "{{.Name}}" | xargs -I {} sh -c 'echo "{}: $(docker volume inspect {} | jq -r ".[0].Options.device // .[0].Mountpoint")"'

echo -e "\n=== RESOURCE USAGE (Top 15) ==="
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" | head -16

echo -e "\n=== RECENT ERRORS (Last hour) ==="
docker compose logs --since 1h --tail=50 | grep -i "error\|fatal\|panic" || echo "No errors found"

echo -e "\n=== ENDPOINT HEALTH CHECKS ==="
curl -fsSL https://devpanl.dev/api/health && echo "✅ DevPanel API" || echo "🔴 DevPanel API"
curl -fsSL https://plane.devpanl.dev/api/instances/ && echo "✅ Plane API" || echo "🔴 Plane API"
curl -fsSL https://affine.devpanl.dev/ && echo "✅ AFFiNE" || echo "🔴 AFFiNE"
curl -fsSL https://penpot.devpanl.dev/api/version && echo "✅ Penpot API" || echo "🔴 Penpot API"
curl -fsSL https://status.devpanl.dev/ && echo "✅ Uptime Kuma" || echo "🔴 Uptime Kuma"
curl -fsSL https://queues.devpanl.dev/ && echo "✅ Bull Board" || echo "🔴 Bull Board"
curl -fsSL https://traefik.devpanl.dev/api/http/routers && echo "✅ Traefik API" || echo "🔴 Traefik API"

echo -e "\n=== REDIS CONNECTION (BullMQ) ==="
docker exec devpanel-redis redis-cli ping && echo "✅ Redis PING successful" || echo "🔴 Redis connection failed"

echo -e "\n=== SSL CERT EXPIRY ==="
echo | openssl s_client -servername devpanl.dev -connect devpanl.dev:443 2>/dev/null | openssl x509 -noout -dates | grep notAfter
```

## Detailed Logs

```bash
# View logs by service
docker compose logs -f --tail=100 devpanel-api    # DevPanel
docker compose logs -f --tail=100 plane-api       # Plane API
docker compose logs -f --tail=100 affine          # AFFiNE
docker compose logs -f --tail=100 traefik         # Traefik
docker compose logs -f --tail=100 penpot-backend  # Penpot
docker compose logs -f --tail=100 bullmq-board    # Bull Board

# View logs by profile
docker compose --profile core logs -f
docker compose --profile plane logs -f
docker compose --profile penpot logs -f
docker compose --profile monitoring logs -f
```

## Restart Services

```bash
# Using Makefile
make restart  # Restart all services

# Using docker compose
docker compose restart devpanel-api     # DevPanel only
docker compose restart plane-api        # Plane API
docker compose --profile core restart   # All core services
docker compose --profile plane restart  # All Plane services
```

## Common Issues

### Redis Connection Errors
```bash
docker exec devpanel-redis redis-cli ping
# Should return: PONG
```

### Postgres Connection Issues
```bash
docker exec plane-db psql -U plane -c "SELECT version();"
docker exec devpanel-postgres psql -U affine -c "SELECT version();"
```

### MinIO Bucket Missing
```bash
docker compose -f docker-compose.plane.yml up plane-minio-init
```

### SSL Cert Not Renewing
```bash
docker compose -f docker-compose.yml logs traefik | grep acme
docker compose -f docker-compose.yml restart traefik
```
