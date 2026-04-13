# Production Deployment — devpanl.dev

## Architecture

```
devpanl.dev (Hetzner)
├── https://devpanl.dev           → DevPanel API (port 3030)
├── https://devpanl.dev/penpot    → Penpot (port 8080)
├── https://devpanl.dev/affine    → AFFiNE (port 3010)
└── https://devpanl.dev/bullmq    → BullMQ Board (port 3000, auth required)
```

## Services (17 containers)

### 1. DevPanel (1 container)
- **devpanel-api** — ghcr.io/franckbirba/dev-panel:latest
- Port: 3030
- Storage: `./storage` (SQLite DBs)

### 2. Traefik (1 container)
- **traefik** — traefik:v3
- Ports: 80, 443
- Auto SSL via Let's Encrypt
- Config: `./traefik` directory

### 3. Penpot (5 containers)
- **penpot-frontend** — penpotapp/frontend:2.14.2
- **penpot-backend** — penpotapp/backend:2.14.2
- **penpot-exporter** — penpotapp/exporter:latest
- **penpot-postgres** — postgres:15
- **penpot-redis** — redis:7
- MCP plugin installable via `install-penpot-mcp.sh`
- Compatible MCP server: `@penpot/mcp@2.14.1` (NOT @beta)

### 4. AFFiNE (4 containers)
- **affine-server** — ghcr.io/toeverything/affine:stable
- **affine-migration** — Migration job (runs once)
- **affine-postgres** — pgvector/pgvector:pg16
- **affine-redis** — redis:7

### 5. BullMQ + Redis (2 containers)
- **bullmq-redis** — redis:7-alpine
- **bullmq-board** — deadly0/bull-board (Web UI)
- Network: `agents` (shared with future Shelly/agents)
- Auth: Basic auth via Traefik middleware

## Networks

- **traefik** — Public-facing, shared by all web services
- **penpot** — Internal network for Penpot services
- **affine** — Internal network for AFFiNE services
- **agents** — Internal network for BullMQ + future agent services (Shelly, etc.)

## Volumes Persistants

```
penpot_postgres     → /var/lib/postgresql/data
penpot_assets       → /opt/data/assets
affine_postgres     → /var/lib/postgresql/data
affine_storage      → /root/.affine/storage
affine_config       → /root/.affine/config
redis_data          → /data (BullMQ Redis persistence)
./storage           → DevPanel SQLite DBs (bind mount)
./traefik           → Traefik config (bind mount)
```

## Variables d'Environnement

### DevPanel
```bash
GITHUB_TOKEN=ghp_xxx
ADMIN_API_KEY=admin_xxx
ALLOWED_ORIGINS=*
NODE_ENV=production
```

### Penpot
```bash
PENPOT_SECRET_KEY=$(openssl rand -hex 32)
PENPOT_DB_PASSWORD=$(openssl rand -hex 16)
PENPOT_SMTP_HOST=smtp.example.com
PENPOT_SMTP_PORT=587
PENPOT_SMTP_TLS=true
PENPOT_SMTP_USERNAME=xxx
PENPOT_SMTP_PASSWORD=xxx
PENPOT_SMTP_FROM=no-reply@devpanl.dev
```

### AFFiNE
```bash
AFFINE_SERVER_ID=$(node -e "console.log(require('crypto').randomUUID())")
AFFINE_DB_USERNAME=affine
AFFINE_DB_PASSWORD=$(openssl rand -hex 16)
AFFINE_DB_NAME=affine
AFFINE_SMTP_HOST=smtp.example.com
AFFINE_SMTP_PORT=587
AFFINE_SMTP_USER=xxx
AFFINE_SMTP_PASSWORD=xxx
AFFINE_SMTP_SENDER=no-reply@devpanl.dev
```

### BullMQ
```bash
# Generate basic auth hash
htpasswd -nb admin yourpassword
# Or use: https://hostingcanada.org/htpasswd-generator/

BULLMQ_BOARD_AUTH='admin:$apr1$xyz$hash_here'
```

## Déploiement

### 1. Première Installation

```bash
# Sur le serveur Hetzner
cd /opt/dev-panel  # ou votre répertoire de choix

# Cloner/copier les fichiers
# - docker-compose.prod.yml
# - .env (depuis .env.example)
# - traefik/ (config directory)
# - install-penpot-mcp.sh

# Générer les secrets
openssl rand -hex 32  # PENPOT_SECRET_KEY
openssl rand -hex 16  # PENPOT_DB_PASSWORD
openssl rand -hex 16  # AFFINE_DB_PASSWORD
node -e "console.log(require('crypto').randomUUID())"  # AFFINE_SERVER_ID
node -e "console.log('admin_' + require('crypto').randomBytes(32).toString('hex'))"  # ADMIN_API_KEY

# Éditer .env avec les secrets générés
nano .env

# Démarrer tous les services
docker compose -f docker-compose.prod.yml up -d

# Vérifier les logs
docker compose -f docker-compose.prod.yml logs -f

# Installer le plugin MCP dans Penpot
PENPOT_CONTAINER=penpot-frontend ./install-penpot-mcp.sh
docker restart penpot-frontend
```

### 2. Mise à Jour

```bash
# Pull les nouvelles images
docker compose -f docker-compose.prod.yml pull

# Redémarrer les services
docker compose -f docker-compose.prod.yml up -d

# Pour DevPanel uniquement
docker compose -f docker-compose.prod.yml up -d devpanel
```

### 3. Vérification

```bash
# Status
docker compose -f docker-compose.prod.yml ps

# Logs
docker compose -f docker-compose.prod.yml logs -f devpanel
docker compose -f docker-compose.prod.yml logs -f penpot-backend
docker compose -f docker-compose.prod.yml logs -f affine

# Test endpoints
curl https://devpanl.dev/api/health
curl https://devpanl.dev/penpot
curl https://devpanl.dev/affine
curl -u admin:yourpassword https://devpanl.dev/bullmq
```

## Backup

### Bases de données
```bash
# Penpot
docker exec penpot-postgres pg_dump -U penpot penpot > penpot_backup_$(date +%Y%m%d).sql

# AFFiNE
docker exec affine-postgres pg_dump -U affine affine > affine_backup_$(date +%Y%m%d).sql
```

### DevPanel storage
```bash
# Backup du répertoire storage
tar -czf devpanel_storage_$(date +%Y%m%d).tar.gz storage/
```

### Volumes Docker
```bash
# Backup volumes Penpot
docker run --rm -v penpot_postgres:/data -v $(pwd):/backup alpine tar czf /backup/penpot_postgres_$(date +%Y%m%d).tar.gz /data
docker run --rm -v penpot_assets:/data -v $(pwd):/backup alpine tar czf /backup/penpot_assets_$(date +%Y%m%d).tar.gz /data

# Backup volumes AFFiNE
docker run --rm -v affine_postgres:/data -v $(pwd):/backup alpine tar czf /backup/affine_postgres_$(date +%Y%m%d).tar.gz /data
docker run --rm -v affine_storage:/data -v $(pwd):/backup alpine tar czf /backup/affine_storage_$(date +%Y%m%d).tar.gz /data
```

## Monitoring

### Health Checks
- DevPanel: `https://devpanl.dev/api/health`
- Penpot: `https://devpanl.dev/penpot` (visual check)
- AFFiNE: `https://devpanl.dev/affine` (visual check)
- Traefik dashboard: À configurer si besoin

### Ressources
```bash
# Docker stats
docker stats

# Disk usage
docker system df -v
df -h

# Logs cleanup
docker system prune -a --volumes  # ⚠️ DANGER: supprime tout ce qui n'est pas utilisé
```

## Troubleshooting

### Penpot ne démarre pas
```bash
# Vérifier les logs
docker logs penpot-backend
docker logs penpot-postgres

# Vérifier la migration
docker compose -f docker-compose.prod.yml up penpot-postgres penpot-redis
docker compose -f docker-compose.prod.yml restart penpot-backend
```

### AFFiNE ne démarre pas
```bash
# Vérifier migration
docker logs affine-migration

# Réexécuter migration si nécessaire
docker compose -f docker-compose.prod.yml up affine-migration
docker compose -f docker-compose.prod.yml restart affine
```

### Plugin MCP Penpot
```bash
# Réinstaller
PENPOT_CONTAINER=penpot-frontend ./install-penpot-mcp.sh
docker restart penpot-frontend

# Vérifier installation
docker exec penpot-frontend ls -la /var/www/app/plugins/mcp/
```

### Traefik SSL
```bash
# Vérifier certificats
docker exec traefik ls -la /etc/traefik/acme.json

# Forcer renouvellement (si expiré)
docker compose -f docker-compose.prod.yml restart traefik
```

## Configuration Traefik (./traefik)

Structure minimale attendue:
```
traefik/
├── traefik.yml           # Config principale
├── acme.json            # Certificats Let's Encrypt (chmod 600)
└── config/
    └── middlewares.yml  # security-headers middleware
```

### traefik.yml (exemple minimal)
```yaml
entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ":443"

providers:
  docker:
    exposedByDefault: false
  file:
    directory: /etc/traefik/config
    watch: true

certificatesResolvers:
  letsencrypt:
    acme:
      email: your-email@example.com
      storage: /etc/traefik/acme.json
      httpChallenge:
        entryPoint: web
```

### config/middlewares.yml (exemple)
```yaml
http:
  middlewares:
    security-headers:
      headers:
        frameDeny: true
        contentTypeNosniff: true
        browserXssFilter: true
        stsSeconds: 31536000
        stsIncludeSubdomains: true
```

## Notes Importantes

- ⚠️ **Penpot MCP**: Utiliser `@penpot/mcp@2.14.1`, PAS @beta (2.15 casse la compatibilité)
- 🐛 **Bug Penpot**: Les pages partagent les éléments → travailler sur une seule page avec frames espacés
- 🔒 **Traefik**: Penser à `chmod 600 traefik/acme.json`
- 📧 **SMTP**: Optionnel pour Penpot/AFFiNE, mais requis pour emails de notif
- 💾 **Backups**: Penser à automatiser (cron)
