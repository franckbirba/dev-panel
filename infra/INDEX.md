# infra/ Directory Structure

Clean, organized infrastructure folder.

## 📁 Structure

```
infra/
├── archive/          # Legacy files (*.bak) — safe to delete after migration
├── claude/           # Claude Code configs (MCP, settings)
├── config/           # Runtime configs (Traefik, systemd, etc.)
├── docs/             # All documentation (README, guides, checklists)
├── nginx/            # Nginx configs for SPAs
├── penpot-mcp/       # Penpot MCP server Dockerfile
├── scripts/          # Setup and maintenance scripts
│   ├── bootstrap/    # Initial VPS setup (Hetzner, cloud-init, etc.)
│   └── maintenance/  # Ongoing ops (backups, monitoring, penpot-mcp install)
├── docker-compose.yml  # Unified compose with profiles
└── init.sh            # Idempotent .env generator
```

## 📂 Folder Details

### `archive/`
**Purpose:** Backup of old files from refactoring
**Contents:** `*.bak` files (old docker-compose, scripts, etc.)
**Action:** Delete once you're confident the new setup works

### `claude/`
**Purpose:** Claude Code configuration for agents server
**Contents:**
- `mcp.json` — MCP servers config
- `settings.json` — Claude Code settings

### `config/`
**Purpose:** Runtime configuration files
**Contents:**
- `traefik.yml` — Traefik static config
- `dynamic.yml` — Traefik dynamic config (middlewares, etc.)
- `.htpasswd` — Basic auth credentials for Traefik dashboard, AFFiNE, Bull Board
- `devpanel-worker.service` — Systemd unit for BullMQ worker
- `uptime-kuma-config.json` — Uptime Kuma monitoring config

**Usage:**
```bash
# Traefik mounts these
docker-compose.yml:
  volumes:
    - ./infra/config/traefik.yml:/etc/traefik/traefik.yml:ro
    - ./infra/config/dynamic.yml:/etc/traefik/dynamic.yml:ro
    - ./infra/config/.htpasswd:/etc/traefik/.htpasswd:ro
```

### `docs/`
**Purpose:** All markdown documentation
**Contents:**
- `README.md` — **Main infrastructure guide** (start here)
- `MIGRATION.md` — Migration from old setup
- `CHECKLIST.md` — Pre-deploy verification
- `SECRETS-GUIDE.md` — Secret management
- `SECURITY-REVIEW.md` — Security best practices
- `DNS-CONFIG.md` — DNS setup for devpanl.dev
- `production-checklist.md` — Production readiness

**Quick links:**
- 📖 [Main Guide](docs/README.md)
- 🏗️ [Architecture Diagrams](docs/ARCHITECTURE.md)
- 🚀 [Migration Guide](docs/MIGRATION.md)
- ✅ [Pre-Deploy Checklist](docs/CHECKLIST.md)
- 🎭 [Playwright Setup](docs/PLAYWRIGHT-SETUP.md)

### `nginx/`
**Purpose:** Nginx configs for SPA routing
**Contents:**
- `spa.conf` — SPA fallback config for Plane (used by plane-web, plane-admin, plane-space)
- `penpot-plugins.conf` — Penpot plugins config

**Usage:**
```yaml
plane-web:
  volumes:
    - ./infra/nginx/spa.conf:/etc/nginx/conf.d/default.conf:ro
```

### `penpot-mcp/`
**Purpose:** Penpot MCP server Docker build
**Contents:**
- `Dockerfile` — Builds `ghcr.io/franckbirba/penpot-mcp:latest`

**Deployment:** Deployed as `penpot-mcp` service in `docker-compose.yml`

### `scripts/bootstrap/`
**Purpose:** Initial VPS setup scripts
**Contents:**
- `hetzner.sh` — Create Hetzner VPS via API
- `cloud-init-services.yml` — Cloud-init for services node (77.42.46.87)
- `cloud-init-agents.yml` — Cloud-init for agents node (62.238.0.167)
- `bootstrap-vps.sh` — Manual VPS bootstrap
- `setup-vps.sh` — Docker + deploy user setup

**Usage:**
```bash
# Create VPS
bash scripts/bootstrap/hetzner.sh

# Or manual setup
bash scripts/bootstrap/setup-vps.sh
```

### `scripts/maintenance/`
**Purpose:** Ongoing operations scripts
**Contents:**
- `backup-cron.sh` — Automated backups (cron job)
- `monitoring-setup.sh` — Deploy Uptime Kuma + Bull Board
- `install-penpot-mcp.sh` — Deploy Penpot MCP server
- `install-playwright.sh` — Install Playwright + Chromium for QA automation (agents node)

**Usage:**
```bash
# Setup monitoring
bash scripts/maintenance/monitoring-setup.sh

# Install Penpot MCP
bash scripts/maintenance/install-penpot-mcp.sh

# Install Playwright (on agents node)
bash scripts/maintenance/install-playwright.sh
```

## 🚀 Quick Start

### First Time Setup
```bash
# 1. Generate .env
make init

# 2. Fill in secrets
vim .env

# 3. Deploy
make deploy-all
```

### Common Tasks
```bash
make help              # Show all commands
make status            # Check service status
make ssh               # SSH into VPS
make deploy-core       # Deploy core stack only
make deploy-plane      # Deploy Plane only
make deploy-penpot     # Deploy Penpot only
make deploy-monitoring # Deploy monitoring only
```

## 📚 Documentation Priority

Read in this order:

1. **[docs/README.md](docs/README.md)** — Complete infrastructure guide
2. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — Full architecture diagrams
3. **[docs/MIGRATION.md](docs/MIGRATION.md)** — If migrating from old setup
4. **[docs/CHECKLIST.md](docs/CHECKLIST.md)** — Before every deploy
5. **[docs/SECRETS-GUIDE.md](docs/SECRETS-GUIDE.md)** — Secret management
6. **[docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md)** — Security hardening
7. **[docs/PLAYWRIGHT-SETUP.md](docs/PLAYWRIGHT-SETUP.md)** — QA automation setup (agents node)

## 🔧 Key Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Unified compose with profiles (core, plane, penpot, monitoring, all) |
| `init.sh` | Idempotent .env generator (preserves existing secrets) |
| `config/traefik.yml` | Traefik static config (entrypoints, Let's Encrypt) |
| `config/dynamic.yml` | Traefik dynamic config (middlewares, security headers) |
| `config/.htpasswd` | Basic auth for Traefik dashboard, AFFiNE, Bull Board |

## 🗑️ Safe to Delete

Once you've verified everything works:

```bash
rm -rf infra/archive/
```

This removes all `*.bak` files from the refactoring.

## 🆘 Help

- **Questions?** Read [docs/README.md](docs/README.md)
- **Migration issues?** Check [docs/MIGRATION.md](docs/MIGRATION.md)
- **Pre-deploy checks?** Run [docs/CHECKLIST.md](docs/CHECKLIST.md)

## 🔐 devpanl.dev SSO — header-spoofing assumption

The `devpanel-api` container trusts Traefik's `X-Forwarded-User` header for SPA
bootstrap (`/api/projects`). This is safe ONLY as long as:

1. The container does not bind a host port (it doesn't — only `traefik` exposes
   80/443). All inbound traffic flows through Traefik on `devpanel_net`.
2. Traefik strips any inbound `X-Forwarded-User` from the client before
   `traefik-forward-auth` injects its own (default thomseddon behavior).
3. `TRUST_FORWARDED_USER` is unset everywhere except the production `devpanel`
   compose service. Local dev defaults to off (curl directly against
   `localhost:3030/api/projects` should 401).

The allowlist lives in `config/oauth2-proxy-emails.txt` and is rendered to
`.env.oauth2-proxy` (gitignored) by `scripts/render-whitelist.sh` during deploy.
Add an invitee = edit the .txt file + push. Only `oauth2-proxy` restarts;
devpanel is untouched.
