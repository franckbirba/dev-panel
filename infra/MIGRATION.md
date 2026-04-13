# Infra Refactoring — Migration Guide

## What Changed

### Before (bordel)
- 4 docker-compose files (`docker-compose.yml`, `docker-compose.plane.yml`, `docker-compose.penpot.yml`, `docker-compose.monitoring.yml`)
- 3 .env generation scripts (`gen-env.sh`, `generate-secrets.sh`, manual GitHub Action heredoc)
- 2 deploy scripts (`deploy.sh`, `deploy-prod.sh`)
- Docs scattered across 5 MD files (`SECRETS-GUIDE.md`, `SECURITY-REVIEW.md`, `DNS-CONFIG.md`, `production-checklist.md`, etc.)
- Manual rsync + ssh commands
- .env generated differently in local vs CI vs server
- No way to test locally with same stack

### After (clean)
- **1 docker-compose.yml** with profiles (`core`, `plane`, `penpot`, `monitoring`, `all`)
- **1 init script** (`infra/init.sh`) — idempotent, preserves secrets
- **1 Makefile** — all commands in one place
- **1 README** (`infra/README.md`) — complete docs
- **Build locally → push to GHCR → pull in prod** — no more building on server
- **Same .env schema everywhere** — init.sh works for local and production
- **GitHub Action reuses Makefile** — no duplication

## New Workflow

### Local Development
```bash
make init       # Creates .env (idempotent)
vim .env        # Fill in GITHUB_TOKEN, etc.
make local      # Runs docker-compose --profile all up -d
```

### Production Deployment
```bash
# Option 1: Makefile (recommended)
make build              # Build image locally
make push               # Push to ghcr.io
make deploy-core        # Deploy core stack
make deploy-all         # Deploy everything

# Option 2: GitHub Actions
git push origin main    # Auto-builds + deploys
```

## File Changes

### New Files
- `Makefile` — deployment automation
- `infra/init.sh` — unified .env generator
- `infra/README.md` — complete infra docs
- `.env.example` — clean template
- `docker-compose.yml` (replaced) — unified compose with profiles

### Archived (renamed to `.bak`)
- `infra/gen-env.sh.bak`
- `infra/generate-secrets.sh.bak`
- `infra/deploy.sh.bak`
- `infra/deploy-prod.sh.bak`
- `infra/docker-compose.*.yml.bak`

### Modified
- `.github/workflows/deploy.yml` — simplified, reuses init.sh
- `README.md` — updated deployment section

## Breaking Changes

### Docker Compose
**Old:**
```bash
cd infra
docker compose -f docker-compose.yml up -d
docker compose -f docker-compose.plane.yml up -d
```

**New:**
```bash
docker compose --profile core up -d
docker compose --profile plane up -d
```

### .env Location
**Old:** `infra/.env` (production)
**New:** `.env.production` (root)

### Network Name
**Old:** External network `devpanel_net` had to be created manually
**New:** Created automatically by docker-compose

## Migration Steps

1. **Pull latest code**
   ```bash
   git pull
   ```

2. **Test locally**
   ```bash
   make init
   vim .env  # Fill in secrets
   make local
   ```

3. **Deploy to production**
   ```bash
   make build
   make push
   make deploy-all
   ```

4. **Verify services**
   ```bash
   make status
   ```

5. **Clean up old files** (once confident)
   ```bash
   rm infra/*.bak
   ```

## Rollback Plan

If something breaks, restore old setup:

```bash
# Restore old files
cd infra
for f in *.bak; do mv "$f" "${f%.bak}"; done

# Old deployment
bash deploy.sh all
```

## FAQ

**Q: Do I need to regenerate secrets?**
A: No. `init.sh` preserves existing secrets from `.env.production`.

**Q: Can I still deploy individual stacks?**
A: Yes. Use `make deploy-core`, `make deploy-plane`, etc.

**Q: What about the worker on agents server?**
A: Not affected. Worker setup unchanged.

**Q: Where are the old docs?**
A: Archived in `infra/*.md` (SECRETS-GUIDE, SECURITY-REVIEW, etc.). Still valid, just not required reading.

**Q: Do I need to update GitHub Secrets?**
A: Maybe. New Action expects `TRAEFIK_USER` and `TRAEFIK_PASS` instead of `TRAEFIK_AUTH`. Add them if missing.

**Q: Can I still use `bash infra/gen-env.sh`?**
A: Use `make init` (local) or `bash infra/init.sh production` (server).

**Q: What happened to `docker-compose.prod.yml`?**
A: Merged into `docker-compose.yml` with profiles. Use `--profile` flag.

## Support

If stuck, check:
- `infra/README.md` — complete reference
- `make help` — all available commands
- Old `.bak` files — reference for what worked before
