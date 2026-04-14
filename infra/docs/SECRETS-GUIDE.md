# Guide de configuration des secrets

## DNS Configuration

### Option 1: Cloudflare (RECOMMANDÉ pour prod externe)

**Configuration requise sur Cloudflare:**

1. **Accéder à votre domaine** (ex: `devpanel.dev`)
2. **Ajouter les A records suivants:**

```
Type  Name       Content              Proxy   TTL
────────────────────────────────────────────────────
A     devpanel   <IP_PUBLIQUE_VPS>    ✅      Auto
A     status     <IP_PUBLIQUE_VPS>    ✅      Auto
A     queues     <IP_PUBLIQUE_VPS>    ✅      Auto
A     traefik    <IP_PUBLIQUE_VPS>    ✅      Auto
```

**⚠️ IMPORTANT:**
- **Proxy Status = ORANGE (proxied)** — Cloudflare gère SSL + DDoS protection
- **SSL/TLS = Full (strict)** dans Cloudflare → Settings → SSL/TLS
- Let's Encrypt sur Traefik fonctionne avec Cloudflare proxied

**Avantages:**
- ✅ Protection DDoS gratuite
- ✅ CDN global
- ✅ SSL géré par Cloudflare
- ✅ Analytics intégrés
- ✅ Firewall rules (block by country, IP, etc.)

### Option 2: DNS interne (pour réseau privé uniquement)

**Si pas d'accès internet public (tests locaux):**

1. **Installer dnsmasq sur le services node:**
```bash
ssh deploy@10.0.0.2
sudo apt install dnsmasq
```

2. **Configurer `/etc/dnsmasq.conf`:**
```bash
# Listen on private interface
interface=eth1
bind-interfaces

# Local domain
local=/local/
domain=devpanel.local

# A records
address=/devpanel.local/10.0.0.2
address=/status.devpanel.local/10.0.0.2
address=/queues.devpanel.local/10.0.0.2
address=/traefik.devpanel.local/10.0.0.2
```

3. **Redémarrer:**
```bash
sudo systemctl restart dnsmasq
```

4. **Sur les clients (laptop, agent node):**
```bash
# Ajouter dans /etc/resolv.conf
nameserver 10.0.0.2
```

**Limitations:**
- ❌ Pas de SSL Let's Encrypt (certificats self-signed uniquement)
- ❌ Accessible uniquement depuis réseau privé 10.0.0.0/24
- ❌ Pas de protection DDoS

**⚡ RECOMMANDATION: Cloudflare pour prod, DNS interne pour dev/staging**

---

## Secrets manquants (à remplir)

### 1. DOMAIN
**Où:** `.env.production`
**Valeur:** Votre domaine principal (ex: `devpanel.dev`)
**Génération:**
```bash
# Edit manuellement
nano .env.production
# Remplacer: DOMAIN=devpanel.yourdomain.com
# Par:       DOMAIN=devpanel.dev
```

### 2. ACME_EMAIL
**Où:** `.env.production`
**Valeur:** Email pour Let's Encrypt (reçoit alertes expiration cert)
**Génération:**
```bash
# Edit manuellement
nano .env.production
# Remplacer: ACME_EMAIL=ops@yourdomain.com
# Par:       ACME_EMAIL=admin@devpanel.dev
```

### 3. ADMIN_API_KEY
**Où:** `.env.production`
**Valeur:** Clé secrète pour endpoints admin (`/api/admin/*`, `/api/health/detailed`)
**Génération:**
```bash
openssl rand -hex 32
# Output: a3f9d8e7c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5
```

**Ajouter à `.env.production`:**
```bash
ADMIN_API_KEY=a3f9d8e7c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5
```

### 4. TRAEFIK_AUTH
**Où:** `.env.production`
**Valeur:** Basic auth pour dashboard Traefik (format htpasswd)
**Génération:**
```bash
# Option 1: avec htpasswd (Apache utils)
htpasswd -nb admin yourpassword
# Output: admin:$apr1$xyz$hashedpassword

# Option 2: en ligne (si pas htpasswd)
# https://hostingcanada.org/htpasswd-generator/
# Username: admin
# Password: yourpassword
```

**Ajouter à `.env.production`:**
```bash
# IMPORTANT: doubler les $ pour Docker Compose
TRAEFIK_AUTH=admin:$$apr1$$xyz$$hashedpassword
```

### 5. GITHUB_TOKEN
**Où:** `.env.production`
**Valeur:** Personal Access Token pour GitHub API
**Génération:**

1. Aller sur https://github.com/settings/tokens
2. **Generate new token (classic)**
3. **Scopes requis:**
   - ✅ `repo` (full access to private repos)
   - ✅ `read:org` (si repos dans org)
4. **Expiration:** No expiration (ou 1 an)
5. Copier le token `ghp_...`

**Ajouter à `.env.production`:**
```bash
GITHUB_TOKEN=ghp_abc123def456ghi789jkl012mno345pqr678stu
```

### 6. SHELLY_TELEGRAM_WEBHOOK
**Où:** `.env.production`
**Valeur:** URL webhook Shelly pour envoyer alerts Telegram
**Génération:**

**Option A: Via BotFather (setup Telegram bot)**
```bash
# 1. Parler à @BotFather sur Telegram
/newbot
# Suivre les instructions, obtenir le token: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz

# 2. Obtenir votre chat ID
# Envoyer un message au bot, puis:
curl https://api.telegram.org/bot123456789:ABCdefGHIjklMNOpqrsTUVwxyz/getUpdates
# Chercher "chat":{"id": 987654321}

# 3. Webhook URL:
SHELLY_TELEGRAM_WEBHOOK=https://api.telegram.org/bot123456789:ABCdefGHIjklMNOpqrsTUVwxyz/sendMessage?chat_id=987654321
```

**Option B: Utiliser instance Shelly existante**
```bash
# Si tu as déjà Shelly déployé:
SHELLY_TELEGRAM_WEBHOOK=https://shelly.yourdomain.com/webhook/telegram
```

**Option C: Skip (désactiver alerts)**
```bash
# Laisser vide, les logs continueront à marcher
SHELLY_TELEGRAM_WEBHOOK=
```

### 7. PENPOT_URL
**Où:** `.env.production`
**Valeur:** URL de l'instance Penpot à monitorer
**Génération:**
```bash
# Si Penpot déployé sur le même VPS:
PENPOT_URL=http://penpot.devpanel.dev

# Si Penpot externe:
PENPOT_URL=https://design.penpot.app

# Si pas de Penpot à monitorer:
PENPOT_URL=
```

### 8. AFFINE_URL
**Où:** `.env.production`
**Valeur:** URL de l'instance AFFiNE à monitorer
**Génération:**
```bash
# Si AFFiNE déployé sur le même VPS:
AFFINE_URL=http://affine.devpanel.dev

# Si AFFiNE externe:
AFFINE_URL=https://app.affine.pro

# Si pas d'AFFiNE à monitorer:
AFFINE_URL=
```

### 9. TELEGRAM_BOT_TOKEN (Uptime Kuma)
**Où:** `.env.production` (optionnel, sert uniquement pour Uptime Kuma)
**Valeur:** Token du bot Telegram (même que pour Shelly)
**Génération:** Voir étape 6, Option A

### 10. TELEGRAM_CHAT_ID (Uptime Kuma)
**Où:** `.env.production` (optionnel)
**Valeur:** Chat ID Telegram
**Génération:** Voir étape 6, Option A

---

## Fichier .env.production final (exemple)

```bash
# ============================================================================
# PRODUCTION ENVIRONMENT VARIABLES
# ============================================================================

# Node
NODE_ENV=production

# Domain (MODIFIER ICI)
DOMAIN=devpanel.dev
ACME_EMAIL=admin@devpanel.dev

# Security (GÉNÉRER ICI)
ADMIN_API_KEY=a3f9d8e7c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5
ALLOWED_ORIGINS=https://devpanel.devpanel.dev

# Traefik Dashboard Auth (GÉNÉRER ICI)
TRAEFIK_AUTH=admin:$$apr1$$xyz$$hashedpassword

# GitHub (GÉNÉRER ICI)
GITHUB_TOKEN=ghp_abc123def456ghi789jkl012mno345pqr678stu

# Monitoring
ENABLE_MONITORING=true
ENABLE_BULLMQ=true
REDIS_HOST=redis
REDIS_PORT=6379

# Alerts (OPTIONNEL)
SHELLY_TELEGRAM_WEBHOOK=https://api.telegram.org/bot123456789:ABCdefGHI/sendMessage?chat_id=987654321
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=987654321

# External services (OPTIONNEL, pour monitoring)
PENPOT_URL=https://design.penpot.app
AFFINE_URL=https://app.affine.pro
```

---

## Uptime Kuma — Configuration post-déploiement

### Où se configure Uptime Kuma?

**1. Accès initial:**
```
URL: https://status.devpanel.dev (après déploiement)
```

**2. Setup wizard (première connexion):**
- Créer compte admin
- Mot de passe fort
- Email (optionnel)

**3. Configuration des monitors:**

**Option A: Import automatique (recommandé)**
```bash
# Après déploiement, SSH sur le serveur
ssh deploy@10.0.0.2

# Le fichier de config est déjà sur le serveur
cat /home/deploy/dev-panel/infra/uptime-kuma-config.json

# Dans Uptime Kuma UI:
# Settings → Backup → Restore → Upload uptime-kuma-config.json
```

**Option B: Création manuelle**

Dans Uptime Kuma UI → Add New Monitor:

**Monitor 1: DevPanel API**
- Monitor Type: HTTP(s)
- Friendly Name: DevPanel API
- URL: `http://10.0.0.2:3030/api/health`
- Heartbeat Interval: 60 seconds
- Retries: 3

**Monitor 2: BullMQ Queues**
- Monitor Type: HTTP(s)
- Friendly Name: BullMQ Queues
- URL: `http://10.0.0.2:3030/api/health/queues`
- Headers: `X-Admin-Key: <votre ADMIN_API_KEY>`
- Heartbeat Interval: 60 seconds

**Monitor 3: Redis**
- Monitor Type: Port
- Hostname: `redis` (ou `10.0.0.2`)
- Port: 6379
- Heartbeat Interval: 60 seconds

**Monitor 4: Penpot (si applicable)**
- Monitor Type: HTTP(s)
- URL: `${PENPOT_URL}/health`
- Heartbeat Interval: 120 seconds

**Monitor 5: AFFiNE (si applicable)**
- Monitor Type: HTTP(s)
- URL: `${AFFINE_URL}/api/health`
- Heartbeat Interval: 120 seconds

**4. Configurer notifications Telegram:**

Dans Uptime Kuma UI → Settings → Notifications → Add:

- Notification Type: **Telegram**
- Friendly Name: `Critical Alerts`
- Bot Token: `<votre TELEGRAM_BOT_TOKEN>`
- Chat ID: `<votre TELEGRAM_CHAT_ID>`
- Apply on All Existing Monitors: ✅

**5. Tester:**
- Stop un service: `docker stop devpanel-api`
- Vérifier alerte Telegram
- Restart: `docker start devpanel-api`

---

## Script de génération automatique (rapide)

```bash
#!/bin/bash
# generate-secrets.sh

echo "🔐 Generating production secrets..."

cat > .env.production << EOF
# Generated on $(date)
NODE_ENV=production

# Domain (EDIT MANUALLY)
DOMAIN=devpanel.dev
ACME_EMAIL=admin@devpanel.dev

# Security
ADMIN_API_KEY=$(openssl rand -hex 32)
ALLOWED_ORIGINS=https://devpanel.\${DOMAIN}

# Traefik Auth (username: admin, password: changeme)
TRAEFIK_AUTH=$(htpasswd -nb admin changeme | sed 's/\$/\$\$/g')

# GitHub (ADD MANUALLY)
GITHUB_TOKEN=ghp_YOUR_TOKEN_HERE

# Monitoring
ENABLE_MONITORING=true
ENABLE_BULLMQ=true
REDIS_HOST=redis
REDIS_PORT=6379

# Alerts (ADD MANUALLY)
SHELLY_TELEGRAM_WEBHOOK=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# External services
PENPOT_URL=
AFFINE_URL=
EOF

echo "✅ Secrets generated in .env.production"
echo ""
echo "⚠️  IMPORTANT: Edit the following manually:"
echo "  - DOMAIN"
echo "  - ACME_EMAIL"
echo "  - GITHUB_TOKEN"
echo "  - SHELLY_TELEGRAM_WEBHOOK (optional)"
echo "  - PENPOT_URL (optional)"
echo "  - AFFINE_URL (optional)"
```

---

## Résumé

| Secret | Obligatoire | Où générer | Durée |
|--------|-------------|------------|-------|
| `DOMAIN` | ✅ | Cloudflare DNS | 5 min |
| `ACME_EMAIL` | ✅ | Email valide | 1 min |
| `ADMIN_API_KEY` | ✅ | `openssl rand -hex 32` | 10 sec |
| `TRAEFIK_AUTH` | ✅ | `htpasswd -nb admin pass` | 10 sec |
| `GITHUB_TOKEN` | ✅ | GitHub Settings | 2 min |
| `VOYAGE_API_KEY` | ✅ | VoyageAI Dashboard | 2 min |
| `SHELLY_TELEGRAM_WEBHOOK` | ⚠️ | BotFather + Shelly | 5 min |
| `PENPOT_URL` | ❌ | Votre URL Penpot | 10 sec |
| `AFFINE_URL` | ❌ | Votre URL AFFiNE | 10 sec |

**Temps total:** ~15-20 minutes
