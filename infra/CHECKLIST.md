# Pre-Deploy Checklist

Run this before deploying to catch issues early.

## ✅ Configuration

- [ ] **Traefik config exists**
  ```bash
  ls -lh infra/traefik.yml infra/dynamic.yml infra/.htpasswd
  ```

- [ ] **SSL cert resolver configured**
  ```bash
  grep "letsencrypt" docker-compose.yml | wc -l  # Should be >10
  ```

- [ ] **All services have TLS labels**
  ```bash
  grep -c "tls.certresolver=letsencrypt" docker-compose.yml  # Should be 9+
  ```

## ✅ Secrets

- [ ] **.env.production will be generated on server**
  ```bash
  grep -A 5 "init.sh production" .github/workflows/deploy.yml
  ```

- [ ] **GitHub Secrets are set** (check repo settings):
  - `ADMIN_API_KEY`
  - `GH_DEPLOY_TOKEN`
  - `AFFINE_DB_PASSWORD`
  - `PLANE_DB_PASSWORD`
  - `PLANE_SECRET_KEY`
  - `PLANE_MINIO_ROOT_USER`
  - `PLANE_MINIO_ROOT_PASSWORD`
  - `PENPOT_SECRET_KEY`
  - `PENPOT_DB_PASSWORD`
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_CHAT_ID`
  - `TRAEFIK_USER`
  - `TRAEFIK_PASS`
  - `VPS_HOST`
  - `VPS_SSH_KEY`

- [ ] **htpasswd generation works**
  ```bash
  bash infra/init.sh production
  ls -lh infra/.htpasswd
  ```

## ✅ Services

- [ ] **All critical services defined**
  ```bash
  docker compose config --services | sort
  # Expected: affine, affine-migration, bull-board, devpanel,
  # plane-api, plane-db, plane-minio, plane-migrator, plane-redis,
  # plane-web, penpot-backend, penpot-exporter, penpot-frontend,
  # penpot-mcp, penpot-postgres, penpot-redis, postgres, redis,
  # traefik, uptime-kuma
  ```

- [ ] **Penpot MCP included**
  ```bash
  grep -c "penpot-mcp" docker-compose.yml  # Should be >5
  ```

- [ ] **Penpot exporter included**
  ```bash
  grep -c "penpot-exporter" docker-compose.yml  # Should be >3
  ```

- [ ] **Penpot Redis included**
  ```bash
  grep -c "penpot-redis" docker-compose.yml  # Should be >5
  ```

## ✅ Networking

- [ ] **All services use devpanel_net**
  ```bash
  grep -c "devpanel_net" docker-compose.yml  # Should be >40
  ```

- [ ] **Redis exposed on VPS IP only**
  ```bash
  grep "6379:6379" docker-compose.yml  # Should have ${VPS_HOST}
  ```

## ✅ Volumes

- [ ] **All volumes declared**
  ```bash
  docker compose config --volumes | sort
  # Expected: affine-config, affine-storage, penpot-assets,
  # penpot-pgdata, penpot-plugins, plane-minio-data, plane-pgdata,
  # plane-redisdata, postgres-data, redis-data, traefik-certs,
  # uptime-kuma-data
  ```

- [ ] **penpot-plugins volume exists**
  ```bash
  grep "penpot-plugins" docker-compose.yml | wc -l  # Should be 2
  ```

## ✅ Build & Push

- [ ] **Dockerfile exists**
  ```bash
  ls -lh Dockerfile
  ```

- [ ] **Image tag correct**
  ```bash
  grep "image: ghcr.io/franckbirba/dev-panel" docker-compose.yml
  ```

- [ ] **GitHub Action builds and pushes**
  ```bash
  grep "docker/build-push-action" .github/workflows/deploy.yml
  ```

## ✅ Deployment

- [ ] **Makefile has all targets**
  ```bash
  make help
  # Should show: init, build, push, local, deploy-core, deploy-plane,
  # deploy-penpot, deploy-monitoring, deploy-all, status, stop, clean,
  # ssh, secrets-rotate
  ```

- [ ] **init.sh is executable**
  ```bash
  test -x infra/init.sh && echo "OK" || echo "FAIL"
  ```

- [ ] **GitHub Action uses init.sh**
  ```bash
  grep "bash infra/init.sh production" .github/workflows/deploy.yml
  ```

## ✅ Local Test

- [ ] **Can generate .env locally**
  ```bash
  make init
  test -f .env && echo "OK" || echo "FAIL"
  ```

- [ ] **Can validate compose**
  ```bash
  docker compose config > /dev/null && echo "OK" || echo "FAIL"
  ```

- [ ] **Can start core profile**
  ```bash
  docker compose --profile core config > /dev/null && echo "OK" || echo "FAIL"
  ```

## ✅ Documentation

- [ ] **README updated**
  ```bash
  grep "make deploy-all" README.md
  ```

- [ ] **infra/README.md complete**
  ```bash
  wc -l infra/README.md  # Should be ~197
  ```

- [ ] **Migration guide exists**
  ```bash
  ls -lh infra/MIGRATION.md
  ```

## Run All Checks

```bash
# Quick validation
docker compose config --quiet && \
  test -f Makefile && \
  test -x infra/init.sh && \
  grep -q "penpot-mcp" docker-compose.yml && \
  grep -q "penpot-exporter" docker-compose.yml && \
  grep -q "penpot-redis" docker-compose.yml && \
  echo "✅ All basic checks passed" || echo "❌ Some checks failed"
```

## Pre-Deploy Smoke Test

```bash
# 1. Generate .env
make init

# 2. Fill in dummy secrets for validation
cat > .env << EOF
NODE_ENV=development
ADMIN_API_KEY=test123
GITHUB_TOKEN=ghp_test123
AFFINE_DB_PASSWORD=test123
PLANE_DB_PASSWORD=test123
PLANE_SECRET_KEY=test123
PLANE_MINIO_ROOT_USER=plane
PLANE_MINIO_ROOT_PASSWORD=test123
PENPOT_SECRET_KEY=test123
PENPOT_DB_PASSWORD=test123
EOF

# 3. Validate compose
docker compose config > /dev/null && echo "✅ Compose valid" || echo "❌ Compose invalid"

# 4. Check all services resolve
docker compose config --services | wc -l  # Should be ~21
```

## Post-Deploy Verification

After `make deploy-all`:

```bash
# SSH into VPS
make ssh

# Check all services running
docker compose ps --format 'table {{.Name}}\t{{.Status}}'

# Check Traefik dashboard
curl -u admin:PASSWORD https://traefik.devpanl.dev

# Check DevPanel health
curl https://devpanl.dev/api/health

# Check Penpot MCP WebSocket
curl -i https://penpot-mcp.devpanl.dev
```
