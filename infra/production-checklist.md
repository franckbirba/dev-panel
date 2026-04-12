# Production Deployment Checklist

## ❌ Manquants critiques

### 1. **Docker Compose principal manquant**
- ❌ Pas de `docker-compose.yml` pour DevPanel API
- ❌ Pas de `docker-compose.traefik.yml` pour reverse proxy
- ✅ `docker-compose.monitoring.yml` existe

**Action requise:**
```bash
# Créer docker-compose.yml avec:
# - devpanel API service
# - Traefik reverse proxy
# - Network bridge devpanel_net
```

### 2. **Secrets & env vars**
- ⚠️  `.env` existe localement mais pas de template prod
- ❌ Pas de secrets management (HashiCorp Vault, AWS Secrets, etc.)
- ⚠️  `ADMIN_API_KEY` non défini
- ⚠️  `SHELLY_TELEGRAM_WEBHOOK` non défini
- ⚠️  `GITHUB_TOKEN` non défini

**Action requise:**
```bash
# Sur le serveur de services (10.0.0.2)
cat > /home/deploy/dev-panel/.env << 'EOF'
NODE_ENV=production
ALLOWED_ORIGINS=https://devpanel.yourdomain.com

# Admin
ADMIN_API_KEY=<générer avec: openssl rand -hex 32>

# GitHub
GITHUB_TOKEN=<github PAT>

# Monitoring
ENABLE_MONITORING=true
ENABLE_BULLMQ=true
REDIS_HOST=redis
REDIS_PORT=6379
SHELLY_TELEGRAM_WEBHOOK=<webhook URL>

# External services
PENPOT_URL=https://penpot.yourdomain.com
AFFINE_URL=https://affine.yourdomain.com
EOF

chmod 600 /home/deploy/dev-panel/.env
```

### 3. **SSL/TLS Certificates**
- ❌ Pas de config Let's Encrypt dans Traefik
- ❌ Pas de domaine configuré

**Action requise:**
- Configurer DNS A records pour:
  - `devpanel.yourdomain.com` → IP publique
  - `status.yourdomain.com` → IP publique
  - `queues.yourdomain.com` → IP publique
- Config Traefik avec Let's Encrypt (voir ci-dessous)

### 4. **Redis persistence**
- ⚠️  Redis avec AOF activé, mais volume non backupé
- ❌ Pas de stratégie backup Redis

**Action requise:**
```bash
# Ajouter backup cron
0 2 * * * docker exec devpanel-redis redis-cli BGSAVE && \
  cp /home/deploy/dev-panel/redis-data/dump.rdb \
  /home/deploy/backups/redis-$(date +\%Y\%m\%d).rdb
```

### 5. **SQLite backups**
- ❌ Pas de backup automatique pour `storage/projects.db`
- ❌ Pas de backup pour project databases

**Action requise:**
```bash
# Ajouter backup cron
0 3 * * * tar -czf /home/deploy/backups/devpanel-storage-$(date +\%Y\%m\%d).tar.gz \
  /home/deploy/dev-panel/storage/
```

### 6. **Log rotation**
- ❌ Pas de config logrotate pour Docker containers

**Action requise:**
```bash
# /etc/logrotate.d/docker-containers
/var/lib/docker/containers/*/*.log {
  rotate 7
  daily
  compress
  missingok
  delaycompress
  copytruncate
}
```

### 7. **Health check automation**
- ❌ Uptime Kuma non configuré (manuel requis)
- ❌ Pas de health check systemd pour auto-restart

**Action requise:**
```bash
# Créer systemd service pour auto-restart on failure
# /etc/systemd/system/devpanel-monitor.service
```

### 8. **Network security**
- ✅ UFW configuré sur cloud-init
- ✅ Bull Board/Uptime Kuma derrière Traefik uniquement (pas de ports publics)
- ✅ Basic auth sur Bull Board
- ⚠️  Uptime Kuma accessible sans auth (protection par obscurité du domain)

**Action optionnelle:**
- Ajouter basic auth sur Uptime Kuma si besoin (actuellement protégé par login UI)

### 9. **Resource limits**
- ❌ Pas de limites mémoire/CPU sur containers Docker
- ⚠️  Redis limité à 256MB (peut être insuffisant)

**Action requise:**
```yaml
# Dans docker-compose.yml
services:
  devpanel:
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 512M
        reservations:
          cpus: '0.5'
          memory: 256M
```

### 10. **Monitoring gaps**
- ❌ Pas de monitoring disk space
- ❌ Pas de monitoring CPU/memory usage
- ❌ Pas d'alertes sur SSL cert expiration

**Action requise:**
- Ajouter monitors Uptime Kuma pour:
  - Disk usage (via script custom)
  - SSL cert expiry
  - Docker container health

### 11. **Agent node (10.0.0.3)**
- ❌ Pas de health endpoint exposé pour OpenClaw/Claude Code
- ❌ Pas de supervision du process agent

**Action requise:**
```bash
# Sur agent node
# Créer simple health server
cat > /home/deploy/health-server.js << 'EOF'
import http from 'http';
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
  }
}).listen(8080);
EOF

# Systemd service pour health server
# /etc/systemd/system/agent-health.service
```

### 12. **Graceful shutdown**
- ⚠️  SIGTERM handler présent dans `index.js`
- ❌ Pas de drain period configuré dans Docker

**Action requise:**
```yaml
# Dans docker-compose.yml
services:
  devpanel:
    stop_grace_period: 30s
```

## ✅ Déjà prêt

- ✅ Health checks API (`/api/health`, `/api/health/detailed`)
- ✅ BullMQ DLQ configuré
- ✅ Alert manager avec Telegram
- ✅ CORS configuré (via ALLOWED_ORIGINS)
- ✅ Helmet security headers
- ✅ Rate limiting (global + routes sensibles)
- ✅ Admin auth avec timing-safe comparison
- ✅ SSH hardening (cloud-init)
- ✅ Firewall UFW (cloud-init)

## 📋 Actions prioritaires (ordre)

1. **Créer docker-compose.yml + Traefik config**
2. **Générer secrets (ADMIN_API_KEY, etc.)**
3. **Configurer DNS + Let's Encrypt**
4. **Setup backups (SQLite + Redis)**
5. **Sécuriser Uptime Kuma/Bull Board (auth Traefik)**
6. **Configurer monitoring complet (Uptime Kuma)**
7. **Tester alerts Telegram**
8. **Setup log rotation**
9. **Resource limits Docker**
10. **Agent node health endpoint**

## 🚀 Quick deploy command (après fixes)

```bash
# Sur services node (10.0.0.2)
cd /home/deploy/dev-panel

# Pull latest code
git pull origin main

# Install deps
npm ci --production

# Build dashboard
npm run build

# Deploy stack
docker-compose up -d
docker-compose -f docker-compose.monitoring.yml up -d

# Verify
docker ps
curl http://localhost:3030/api/health
```

## ⚠️  Verdict

**NON, pas prêt pour la prod.**

**Critiques manquants:**
- Docker Compose principal
- Traefik config
- Secrets management
- SSL/TLS setup
- Backups automatiques
- Uptime Kuma configuration

**Estimation temps:** 4-6h pour mise en prod complète.
