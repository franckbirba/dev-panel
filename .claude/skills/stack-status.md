---
name: stack-status
description: Check status and health of all OpenClaw stack services
---

# Stack Status & Health Check

Quick overview of all running services in the OpenClaw infrastructure.

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

## Quick Status

```bash
#!/bin/bash

echo "=== CONTAINER STATUS ==="
docker ps --filter "network=devpanel_net" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | head -30

echo -e "\n=== HEALTH CHECKS ==="
docker ps --filter "health=unhealthy" --format "🔴 {{.Names}}: {{.Status}}"
docker ps --filter "health=healthy" --format "✅ {{.Names}}"

echo -e "\n=== DISK USAGE ==="
docker system df

echo -e "\n=== VOLUME USAGE ==="
docker volume ls --filter "name=plane" --format "{{.Name}}" | xargs -I {} sh -c 'echo -n "{}: "; docker volume inspect {} | jq -r ".[0].Options.device // .[0].Mountpoint"'

echo -e "\n=== RESOURCE USAGE ==="
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" | head -15

echo -e "\n=== RECENT ERRORS ==="
docker compose -f /home/deploy/dev-panel/infra/docker-compose.yml logs --since 1h --tail=20 | grep -i error || echo "No errors"
docker compose -f /home/deploy/dev-panel/infra/docker-compose.plane.yml logs --since 1h --tail=20 | grep -i error || echo "No errors"

echo -e "\n=== ENDPOINT CHECKS ==="
curl -fsSL https://devpanl.dev/health && echo "✅ DevPanel API" || echo "🔴 DevPanel API"
curl -fsSL https://plane.devpanl.dev/api/instances/ && echo "✅ Plane API" || echo "🔴 Plane API"
curl -fsSL https://affine.devpanl.dev/ && echo "✅ AFFiNE" || echo "🔴 AFFiNE"
curl -fsSL https://traefik.devpanl.dev/api/http/routers && echo "✅ Traefik API" || echo "🔴 Traefik API"

echo -e "\n=== SSL CERT EXPIRY ==="
echo | openssl s_client -servername devpanl.dev -connect devpanl.dev:443 2>/dev/null | openssl x509 -noout -dates | grep notAfter
```

## Detailed Logs

```bash
# DevPanel
docker compose -f docker-compose.yml logs -f --tail=100 devpanel

# Plane API
docker compose -f docker-compose.plane.yml logs -f --tail=100 plane-api

# AFFiNE
docker compose -f docker-compose.yml logs -f --tail=100 affine

# Traefik
docker compose -f docker-compose.yml logs -f --tail=100 traefik
```

## Restart Specific Service

```bash
# Restart DevPanel only
docker compose -f docker-compose.yml restart devpanel

# Restart Plane API
docker compose -f docker-compose.plane.yml restart plane-api

# Restart all Plane services
docker compose -f docker-compose.plane.yml restart
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
