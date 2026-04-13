---
name: stack-deploy
description: Deploy the full OpenClaw stack (DevPanel + Plane + AFFiNE + Penpot + monitoring)
---

# Deploy Full OpenClaw Stack

This skill orchestrates deployment of the complete infrastructure stack as defined in the flowchart.

## Stack Components

Based on `/docs/flowchart.md` and `/infra/*.yml`:

- **Traefik**: Reverse proxy with Let's Encrypt (ports 80/443)
- **DevPanel API**: Main bug/feature reporting system
- **Plane**: Project management (web, admin, space, live, API, worker, beat)
- **AFFiNE**: Docs & knowledge base (with migration job)
- **Penpot**: Design tool (frontend, backend, exporter)
- **PostgreSQL**: Shared by AFFiNE + Plane (separate DBs)
- **Redis**: Shared (BullMQ + Plane queues)
- **MinIO**: S3-compatible storage for Plane uploads
- **Monitoring**: Grafana, Prometheus, Loki (optional)

## Pre-flight Checks

1. Verify `.env.production` exists with all required secrets
2. Check Docker network `devpanel_net` exists
3. Verify DNS points to server (devpanl.dev, *.devpanl.dev)
4. Ensure ports 80/443 are available

## Deployment Order

```bash
# 1. Create network if missing
docker network create devpanel_net || true

# 2. Deploy core services (Traefik + Redis + Postgres)
cd /home/deploy/dev-panel/infra
docker compose -f docker-compose.yml up -d traefik redis postgres

# 3. Deploy AFFiNE (migration first)
docker compose -f docker-compose.yml up affine-migration
docker compose -f docker-compose.yml up -d affine

# 4. Deploy DevPanel API
docker compose -f docker-compose.yml up -d devpanel

# 5. Deploy Plane stack
docker compose -f docker-compose.plane.yml up -d

# 6. Deploy Penpot (optional)
docker compose -f docker-compose.penpot.yml up -d

# 7. Deploy monitoring (optional)
docker compose -f docker-compose.monitoring.yml up -d
```

## Health Checks

```bash
# Check all services
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Check logs for errors
docker compose -f docker-compose.yml logs --tail=50

# Verify endpoints
curl -fsSL https://devpanl.dev/health
curl -fsSL https://plane.devpanl.dev/api/instances/
curl -fsSL https://affine.devpanl.dev/
```

## Rollback

```bash
# Stop all services
docker compose -f docker-compose.yml down
docker compose -f docker-compose.plane.yml down
docker compose -f docker-compose.penpot.yml down
docker compose -f docker-compose.monitoring.yml down

# Restore from backup
/home/deploy/dev-panel/infra/backup-cron.sh restore
```

## Post-Deploy

1. Check Traefik dashboard: https://traefik.devpanl.dev
2. Verify SSL certs issued (Let's Encrypt)
3. Test BullMQ connection (DevPanel → Redis)
4. Create Plane workspace + first project
5. Create AFFiNE workspace
6. Configure Penpot team
7. Test DevPanel widget → API → ticket creation

## Secrets Required

From `.env.production`:
- `ADMIN_API_KEY`
- `GITHUB_TOKEN`
- `AFFINE_DB_PASSWORD`
- `PLANE_DB_PASSWORD`
- `PLANE_SECRET_KEY`
- `PLANE_MINIO_ROOT_USER`
- `PLANE_MINIO_ROOT_PASSWORD`
- `TRAEFIK_AUTH` (htpasswd format)
- `SHELLY_TELEGRAM_WEBHOOK` (optional)
- `PENPOT_URL` (optional)

Generate secrets: `/home/deploy/dev-panel/infra/generate-secrets.sh`

## Monitoring URLs

- Traefik: https://traefik.devpanl.dev
- Grafana: https://grafana.devpanl.dev
- Prometheus: http://localhost:9090 (internal only)
- DevPanel: https://devpanl.dev
- Plane: https://plane.devpanl.dev
- AFFiNE: https://affine.devpanl.dev
- Penpot: https://penpot.devpanl.dev
- MinIO: https://minio.devpanl.dev
