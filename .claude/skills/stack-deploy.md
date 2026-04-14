---
name: stack-deploy
description: Deploy the full dev-panel stack using Makefile (core, plane, penpot, monitoring)
---

# Deploy Full dev-panel Stack

This skill orchestrates deployment using the unified `Makefile` and `docker-compose.yml` with profiles.

## Stack Components

Based on `/docker-compose.yml` with profiles:

**Core Profile** (7 services):
- **Traefik**: Reverse proxy with Let's Encrypt (ports 80/443)
- **Redis**: BullMQ job queue + Plane cache (exposed on 77.42.46.87:6379 for agents)
- **DevPanel API**: Bug/feature reporting system
- **AFFiNE**: Docs & knowledge base
- **MCP Servers**: plane-mcp, obsidian-mcp, penpot-mcp

**Plane Profile** (10 services):
- Plane Web, Admin, Space, API, Worker, Beat Worker
- Plane Postgres, Redis, MinIO, Valkey

**Penpot Profile** (6 services):
- Penpot Frontend, Backend, Postgres, Exporter, Redis, MCP

**Monitoring Profile** (2 services):
- Uptime Kuma, Bull Board

## Pre-flight Checks

Run checklist before deployment:

```bash
# Read full checklist
cat infra/docs/CHECKLIST.md

# Key checks:
# 1. .env.production exists with all secrets
# 2. Docker network devpanel_net created
# 3. DNS points to 77.42.46.87 (A records for devpanl.dev, *.devpanl.dev)
# 4. Ports 80/443/6379 available
# 5. htpasswd file exists at infra/config/.htpasswd
# 6. Traefik configs at infra/config/*.yml
```

## Deployment Workflow

### Using Makefile (Recommended)

```bash
# Local: Build and push Docker image
make build    # Build ghcr.io/franckbirba/dev-panel:latest
make push     # Push to GHCR

# Production: Deploy all services
make deploy-all  # Deploys all 4 profiles (core, plane, penpot, monitoring)

# Or deploy specific stacks
make deploy-core       # Core only (traefik, redis, devpanel, affine, mcp servers)
make deploy-plane      # Add Plane project management
make deploy-penpot     # Add Penpot design tool
make deploy-monitoring # Add monitoring stack
```

### Manual Deployment (if Makefile unavailable)

```bash
# SSH into services node
ssh -i ~/.ssh/hetzner-vps deploy@77.42.46.87

# Navigate to project
cd ~/dev-panel

# Generate .env.production (idempotent, preserves secrets)
bash infra/init.sh production

# Create network
docker network create devpanel_net || true

# Pull latest images
docker compose pull

# Deploy by profile
docker compose --profile core up -d       # Core services
docker compose --profile plane up -d      # Plane stack
docker compose --profile penpot up -d     # Penpot stack
docker compose --profile monitoring up -d # Monitoring

# Or deploy all at once
docker compose --profile all up -d
```

## Health Checks

```bash
# Check all running services
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Check specific profile services
docker compose --profile core ps
docker compose --profile plane ps

# View logs
docker compose logs -f devpanel-api
docker compose logs -f plane-web --tail=100

# Test endpoints
curl -fsSL https://devpanl.dev/api/health
curl -fsSL https://plane.devpanl.dev/api/instances/
curl -fsSL https://affine.devpanl.dev/
curl -fsSL https://penpot.devpanl.dev/
curl -fsSL https://status.devpanl.dev/  # Uptime Kuma
curl -fsSL https://queues.devpanl.dev/  # Bull Board
```

## Rollback

```bash
# Stop all services
make stop  # Or: docker compose --profile all down

# Rollback to previous image
docker compose pull  # Pull stable tag if available
docker compose --profile all up -d

# Restore from backup (if needed)
bash infra/scripts/maintenance/backup-cron.sh restore
```

## Post-Deploy Verification

1. **Traefik Dashboard**: https://traefik.devpanl.dev (htpasswd auth)
   - Verify SSL certs issued (Let's Encrypt)
   - Check all routers active (11 services with HTTPS)

2. **Test DevPanel API**:
   ```bash
   curl -H "X-Admin-Key: $ADMIN_API_KEY" https://devpanl.dev/api/projects
   ```

3. **Test BullMQ Connection**:
   ```bash
   # From agents node (62.238.0.167)
   redis-cli -h 77.42.46.87 -p 6379 ping
   ```

4. **Create Plane Workspace**:
   - Visit https://plane.devpanl.dev
   - Create workspace "devpanl"
   - Create first project

5. **Configure AFFiNE**:
   - Visit https://affine.devpanl.dev
   - Create workspace
   - Copy workspace ID for MCP config

6. **Test DevPanel Widget**:
   - Add widget to test app
   - Submit bug report
   - Verify ticket in CLI: `node bin/dev-panel.js list`

## Secrets Management

Generate secrets with:

```bash
# Initialize .env (local)
make init

# Or manually on server
bash infra/init.sh production
```

**Required secrets** (see `infra/docs/SECRETS-GUIDE.md`):
- `ADMIN_API_KEY` — DevPanel admin access
- `GITHUB_TOKEN` — GitHub sync
- `AFFINE_DB_PASSWORD` — AFFiNE database
- `PLANE_DB_PASSWORD` — Plane database
- `PLANE_SECRET_KEY` — Plane session secret
- `PLANE_MINIO_ROOT_PASSWORD` — Plane file storage
- `PENPOT_SECRET_KEY` — Penpot session secret
- `PENPOT_DB_PASSWORD` — Penpot database
- `TELEGRAM_BOT_TOKEN` — Shelly notifications (optional)
- `TELEGRAM_CHAT_ID` — Franck's chat ID (optional)

**htpasswd file** (for Traefik dashboard, AFFiNE, Bull Board):
- Auto-generated by `infra/init.sh production`
- Location: `infra/config/.htpasswd`
- Default user: `admin`

## Service URLs

| Service | URL | Auth |
|---------|-----|------|
| DevPanel API | https://devpanl.dev | API key |
| AFFiNE | https://affine.devpanl.dev | htpasswd |
| Plane | https://plane.devpanl.dev | Plane auth |
| Penpot | https://penpot.devpanl.dev | Penpot auth |
| Penpot MCP | https://penpot-mcp.devpanl.dev | Internal |
| Traefik Dashboard | https://traefik.devpanl.dev | htpasswd |
| Uptime Kuma | https://status.devpanl.dev | Kuma auth |
| Bull Board | https://queues.devpanl.dev | htpasswd |

## Common Issues

**Issue**: Services not starting
- **Check**: `docker compose logs <service>`
- **Fix**: Verify env vars, check ports, restart service

**Issue**: SSL cert not issued
- **Check**: Traefik logs for Let's Encrypt errors
- **Fix**: Verify DNS points to server, check port 80/443 open

**Issue**: Redis connection fails from agents node
- **Check**: `redis-cli -h 77.42.46.87 -p 6379 ping`
- **Fix**: Verify Redis exposed on `77.42.46.87:6379` in docker-compose.yml

**Issue**: htpasswd auth fails
- **Check**: `cat infra/config/.htpasswd`
- **Fix**: Regenerate with `bash infra/init.sh production`

## Documentation

- **Main Guide**: `infra/docs/README.md`
- **Architecture Diagrams**: `infra/docs/ARCHITECTURE.md`
- **Pre-Deploy Checklist**: `infra/docs/CHECKLIST.md`
- **Migration Guide**: `infra/docs/MIGRATION.md`
- **Secrets Guide**: `infra/docs/SECRETS-GUIDE.md`
