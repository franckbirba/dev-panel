# dev-panel Infrastructure

Complete production infrastructure for dev-panel. **One docker-compose, one Makefile, one init script.**

## Architecture

```
Production Stack (77.42.46.87)
├── Core (profile: core)
│   ├── Traefik          → reverse proxy, HTTPS, Let's Encrypt
│   ├── Redis            → BullMQ backend (exposed on VPS IP:6379)
│   ├── DevPanel         → main app (ghcr.io/franckbirba/dev-panel:latest)
│   ├── PostgreSQL       → AFFiNE database
│   └── AFFiNE           → docs & knowledge base
├── Plane (profile: plane)
│   ├── Web/Admin/Space  → frontend SPAs
│   ├── API/Worker/Beat  → backend services
│   ├── PostgreSQL       → Plane database
│   ├── Redis            → Plane cache (separate from core)
│   └── MinIO            → S3-compatible file storage
├── Penpot (profile: penpot)
│   ├── Frontend         → design tool UI
│   ├── Backend          → API server
│   └── PostgreSQL       → Penpot database
└── Monitoring (profile: monitoring)
    ├── Uptime Kuma      → service monitoring
    └── Bull Board       → job queue dashboard
```

## Quick Start

### Local Development

```bash
# 1. Initialize .env (idempotent — preserves existing secrets)
make init

# 2. Fill in missing values
vim .env  # Add GITHUB_TOKEN, TELEGRAM_BOT_TOKEN, etc.

# 3. Run everything locally
make local
```

### Production Deployment

```bash
# 1. Build + push image to GHCR
make build
make push

# 2. Deploy specific stack
make deploy-core       # Just core (traefik, devpanel, affine)
make deploy-plane      # Just Plane
make deploy-penpot     # Just Penpot
make deploy-monitoring # Just monitoring

# 3. Or deploy everything
make deploy-all
```

## Services & URLs

| Service       | URL                              | Auth                  |
|---------------|----------------------------------|-----------------------|
| DevPanel      | https://devpanl.dev              | API key               |
| AFFiNE        | https://affine.devpanl.dev       | htpasswd (admin/...)  |
| Plane         | https://plane.devpanl.dev        | Email/password        |
| Penpot        | https://penpot.devpanl.dev       | Email/password        |
| Traefik       | https://traefik.devpanl.dev      | htpasswd (admin/...)  |
| Uptime Kuma   | https://status.devpanl.dev       | Web UI                |
| Bull Board    | https://queues.devpanl.dev       | htpasswd (admin/...)  |
| MinIO         | https://minio.devpanl.dev        | AWS credentials       |

## Configuration

### Environment Files

- **Local:** `.env` (created by `make init`)
- **Production:** `.env.production` (created by `infra/init.sh production`)

Both use the same schema — init script preserves existing secrets across re-runs.

### Secrets

**Generated automatically:**
- All database passwords
- Secret keys for Plane, Penpot
- API keys
- MinIO credentials

**User-provided:**
- `GITHUB_TOKEN` — for issue publishing
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — for notifications
- `TRAEFIK_USER`, `TRAEFIK_PASS` — for htpasswd (production only)

## File Structure

```
dev-panel/
├── docker-compose.yml          # Unified compose with profiles
├── Makefile                    # Deployment automation
├── Dockerfile                  # DevPanel image build
├── .env                        # Local config (gitignored)
├── .env.production             # Production config (server only)
└── infra/
    ├── init.sh                 # Idempotent .env generator
    ├── .htpasswd               # Traefik basic auth (production)
    ├── traefik.yml             # Traefik static config
    ├── dynamic.yml             # Traefik dynamic config
    ├── nginx/spa.conf          # Plane SPA config
    └── *.bak                   # Archived legacy files
```

## Docker Compose Profiles

Use `--profile` to launch subsets:

```bash
# Local
docker compose --profile core up -d
docker compose --profile plane up -d
docker compose --profile penpot up -d
docker compose --profile monitoring up -d
docker compose --profile all up -d

# Production (via Makefile)
make deploy-core
make deploy-plane
make deploy-penpot
make deploy-monitoring
make deploy-all
```

## Troubleshooting

### .env generation fails

```bash
# Check existing .env
cat .env.production

# Regenerate (preserves existing secrets)
bash infra/init.sh production
```

### Services won't start

```bash
# Check status
make status

# Check logs
ssh -i ~/.ssh/hetzner-vps deploy@77.42.46.87
docker compose logs -f devpanel
docker compose logs -f traefik
```

### Reset everything (⚠️ DESTRUCTIVE)

```bash
make clean  # Removes all containers + volumes
```

## GitHub Actions

Automated deployment on push to `main`:

1. Build `ghcr.io/franckbirba/dev-panel:latest`
2. Push to GitHub Container Registry
3. SSH into VPS
4. Generate `.env.production` from GitHub Secrets
5. Pull latest image
6. Start all services (core, plane, penpot, monitoring)
7. Health check + cleanup

All secrets stored in GitHub repo settings → Secrets & variables → Actions.

## Differences from Legacy Setup

| Old | New |
|-----|-----|
| 4 docker-compose files | 1 with profiles |
| 3 .env generation scripts | 1 idempotent init.sh |
| Manual rsync + ssh | Makefile automation |
| Separate deploy scripts | `make deploy-X` |
| .env on server manually managed | Auto-generated from GitHub Secrets |
| Build on server | Build locally + push to GHCR |
| Docs scattered across 5 MD files | This README |

## Migration from Legacy

1. Backup existing `.env` on server
2. Pull latest code
3. Run `make deploy-all`
4. Verify services at URLs above
5. Delete `infra/*.bak` when confident
