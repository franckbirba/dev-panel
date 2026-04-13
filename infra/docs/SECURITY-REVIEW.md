# Security Review — DevPanel Production

## ✅ Sécurité réseau (corrigé)

### Exposition des services

**AVANT (vulnérable):**
```yaml
bull-board:
  ports:
    - "3002:3000"  # ❌ Exposé publiquement !
```

**APRÈS (sécurisé):**
```yaml
bull-board:
  # NO PUBLIC PORT - access via Traefik only
  labels:
    - "traefik.http.routers.bullboard.middlewares=bullboard-auth"
    - "traefik.http.middlewares.bullboard-auth.basicauth.users=${TRAEFIK_AUTH}"
```

### Flux d'accès sécurisé

```
Internet
   ↓
Traefik (HTTPS + Let's Encrypt)
   ↓
Basic Auth (username/password)
   ↓
Bull Board (réseau interne Docker)
```

**Avantages:**
- ✅ Pas de port exposé directement
- ✅ SSL/TLS obligatoire
- ✅ Basic auth avant accès
- ✅ Rate limiting Traefik intégré

---

## 🔒 Matrice de sécurité

| Service | Port public | Auth | SSL | Exposition |
|---------|-------------|------|-----|------------|
| Traefik | 80, 443 | Basic auth (dashboard) | ✅ Let's Encrypt | Public |
| DevPanel API | - | API Key (`X-API-Key`) | ✅ via Traefik | Public |
| Uptime Kuma | - | Login UI | ✅ via Traefik | Public |
| Bull Board | - | Basic auth | ✅ via Traefik | Public |
| Redis | - | ❌ None | ❌ Internal only | Private |

---

## 🛡️ Mesures de protection

### 1. **Firewall (UFW)**
```bash
# Configuré dans cloud-init
ufw allow 22/tcp      # SSH
ufw allow 80/tcp      # HTTP (redirect → HTTPS)
ufw allow 443/tcp     # HTTPS
ufw allow from 10.0.0.0/24  # Private network
ufw default deny incoming
```

### 2. **Traefik Security Headers**
```yaml
# Helmet (Express) + Traefik
- CSP (Content Security Policy)
- HSTS (HTTP Strict Transport Security)
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
```

### 3. **Rate Limiting**
```javascript
// src/server/routes.js
globalLimiter: 100 req/min
ticketCreateLimiter: 30 req/min
authLimiter: 20 req/min
```

### 4. **API Authentication**

**Admin endpoints** (`/api/admin/*`, `/api/health/detailed`):
```javascript
authenticateAdmin(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  // Timing-safe comparison
  timingSafeEqual(Buffer.from(adminKey), Buffer.from(configuredKey));
}
```

**Project endpoints** (`/api/tickets/*`):
```javascript
authenticateProject(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  const project = getProjectByApiKey(apiKey);
}
```

### 5. **Secrets Management**

**Stockage:**
- ❌ Jamais en clair dans le code
- ✅ `.env.production` (chmod 600)
- ✅ `.env` dans `.gitignore`
- ✅ Rotation recommandée tous les 90 jours

**Génération:**
```bash
# ADMIN_API_KEY: 256-bit entropy
openssl rand -hex 32

# Traefik auth: bcrypt hashed
htpasswd -nb admin password
```

---

## 🚨 Vulnérabilités potentielles (à surveiller)

### 1. **Redis sans auth**
**Statut:** ⚠️ WARNING
**Impact:** Accès interne uniquement (réseau Docker)
**Mitigation actuelle:**
- Redis écoute uniquement sur réseau `devpanel_net` (bridge interne)
- Pas de port exposé publiquement
- UFW bloque accès externe

**Amélioration recommandée:**
```yaml
redis:
  command: redis-server --requirepass ${REDIS_PASSWORD} --appendonly yes
  environment:
    REDIS_PASSWORD: ${REDIS_PASSWORD}
```

### 2. **SQLite file permissions**
**Statut:** ⚠️ WARNING
**Impact:** Accès filesystem = accès aux données
**Mitigation actuelle:**
- Container user `node` (non-root)
- Volume bind: `/home/deploy/dev-panel/storage` (owned by `deploy`)

**Amélioration recommandée:**
```dockerfile
# Dans Dockerfile
RUN chmod 600 /app/storage/*.db
```

### 3. **Session fixation (Uptime Kuma)**
**Statut:** ⚠️ WARNING
**Impact:** Session hijacking si cookie volé
**Mitigation actuelle:**
- HTTPS obligatoire
- Cookies `Secure` + `HttpOnly`

**Amélioration recommandée:**
- Ajouter basic auth Traefik devant Uptime Kuma
- Ou limiter accès par IP (Cloudflare firewall)

### 4. **DDoS sur API publique**
**Statut:** ⚠️ WARNING
**Impact:** Surcharge serveur
**Mitigation actuelle:**
- Rate limiting Express (100 req/min global)
- Cloudflare proxy (si activé)

**Amélioration recommandée:**
```yaml
# Traefik rate limit middleware
- "traefik.http.middlewares.api-ratelimit.ratelimit.average=100"
- "traefik.http.middlewares.api-ratelimit.ratelimit.burst=50"
```

---

## 🔐 Checklist de hardening supplémentaire

### SSH (déjà configuré via cloud-init)
- ✅ PermitRootLogin no
- ✅ PasswordAuthentication no
- ✅ Key-based auth only

### Docker
- ⚠️ Ajouter resource limits (CPU/RAM) → **FAIT**
- ⚠️ Scanner images: `docker scan devpanel-api`
- ⚠️ Utiliser Docker secrets au lieu d'env vars

### Monitoring
- ✅ Uptime Kuma health checks
- ✅ Dead Letter Queue pour failed jobs
- ⚠️ Ajouter fail2ban pour SSH brute-force

### Backups
- ✅ Cron backup SQLite + Redis
- ⚠️ Tester restore procedure
- ⚠️ Chiffrer backups (GPG ou AWS S3 encryption)

### Logs
- ⚠️ Centralized logging (Loki, Graylog, etc.)
- ⚠️ Log rotation (logrotate)
- ⚠️ Audit logs pour actions admin

---

## 📊 Score de sécurité

| Catégorie | Score | Notes |
|-----------|-------|-------|
| Network Security | 9/10 | Traefik + UFW + no public ports |
| Authentication | 8/10 | API keys + basic auth, Redis unauth |
| Encryption | 10/10 | HTTPS partout via Let's Encrypt |
| Secrets Management | 7/10 | .env files, manque rotation auto |
| Rate Limiting | 8/10 | Express + Traefik, peut être renforcé |
| Monitoring | 9/10 | Uptime Kuma + alerts + DLQ |
| Backups | 7/10 | Automatisés, manque chiffrement |
| **TOTAL** | **8.3/10** | **Production-ready** |

---

## 🎯 Recommandations prioritaires

1. **Court terme (avant prod):**
   - ✅ Retirer ports publics Bull Board/Uptime Kuma → **FAIT**
   - ⚠️ Tester backup/restore
   - ⚠️ Configurer Cloudflare Firewall rules

2. **Moyen terme (première semaine):**
   - Ajouter Redis password
   - Scanner images Docker
   - Setup fail2ban

3. **Long terme (premier mois):**
   - Rotation automatique secrets (Vault?)
   - Centralized logging
   - Penetration testing

---

## 🔍 Audit commands

```bash
# Check exposed ports
nmap -p- <IP_PUBLIQUE>

# Test rate limiting
ab -n 1000 -c 10 https://devpanel.devpanel.dev/api/health

# Verify SSL
curl -I https://devpanel.devpanel.dev

# Check Docker security
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy image devpanel-api

# Review firewall rules
ssh deploy@10.0.0.2 'sudo ufw status verbose'
```

---

## ✅ Validation finale

**Avant de passer en prod, vérifier:**

- [ ] Aucun port sensible exposé (`nmap -p- <IP>`)
- [ ] SSL/TLS actif (`curl -I https://...`)
- [ ] Basic auth fonctionne (Bull Board)
- [ ] Rate limiting actif (test avec `ab`)
- [ ] Secrets générés (`.env.production` rempli)
- [ ] Backups testés (restore d'un backup)
- [ ] Monitoring configuré (Uptime Kuma + Telegram)
- [ ] DNS configuré (A records Cloudflare)
- [ ] Firewall actif (`ufw status`)
- [ ] Health checks OK (`/api/health`)
