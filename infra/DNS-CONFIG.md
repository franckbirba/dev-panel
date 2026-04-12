# Configuration DNS finale pour devpanl.dev

## Records Cloudflare configurés

| Type | Name | Content | Proxy | Usage |
|------|------|---------|-------|-------|
| A | `devpanl.dev` | 77.42.46.87 | 🟠 Proxied | **API principale + Dashboard** |
| A | `status` | 77.42.46.87 | 🟠 Proxied | Uptime Kuma monitoring |
| A | `queues` | 77.42.46.87 | 🟠 Proxied | Bull Board (BullMQ dashboard) |
| A | `traefik` | 77.42.46.87 | 🟠 Proxied | Traefik dashboard |

## ✅ Action requise

**Modifier le record apex `devpanl.dev` :**
1. Dans Cloudflare DNS
2. Click **Edit** sur la ligne `devpanl.dev`
3. Changer **Proxy status** : DNS only → 🟠 **Proxied**
4. Save

## URLs finales (après déploiement)

```
API & Dashboard:  https://devpanl.dev
Uptime Kuma:      https://status.devpanl.dev
Bull Board:       https://queues.devpanl.dev
Traefik:          https://traefik.devpanl.dev
```

## Endpoints API

### Public
- `GET  https://devpanl.dev/api/health` — Health check
- `GET  https://devpanl.dev/api/metrics` — Prometheus metrics
- `POST https://devpanl.dev/api/tickets` — Create ticket (require `X-API-Key`)

### Dashboard
- `GET  https://devpanl.dev/dashboard` — Web dashboard SPA

### Admin (require `X-Admin-Key` header)
- `GET  https://devpanl.dev/api/health/detailed` — Detailed health
- `GET  https://devpanl.dev/api/health/queues` — Queue status
- `GET  https://devpanl.dev/api/admin/dlq` — Dead Letter Queue
- `POST https://devpanl.dev/api/admin/dlq/:id/retry` — Retry failed job

### Project-scoped (require `X-API-Key` header)
- `GET  https://devpanl.dev/api/tickets` — List tickets
- `GET  https://devpanl.dev/api/tickets/:id` — Get ticket
- `POST https://devpanl.dev/api/tickets/:id/publish` — Publish to GitHub
- `GET  https://devpanl.dev/api/stats` — Project stats
- `GET  https://devpanl.dev/api/activity` — Activity feed

## SSL/TLS

**Cloudflare settings:**
- SSL/TLS mode: **Full (strict)**
- Always Use HTTPS: **On**
- Minimum TLS Version: **TLS 1.2**

**Let's Encrypt:**
- Certificates auto-générés par Traefik
- Renewal automatique tous les 60 jours
- Storage: `/home/deploy/dev-panel/traefik-certs/acme.json`

## Vérification post-déploiement

```bash
# Test SSL
curl -I https://devpanl.dev
# Expect: HTTP/2 200

# Test API health
curl https://devpanl.dev/api/health
# Expect: {"status":"ok","timestamp":"..."}

# Test Uptime Kuma
curl -I https://status.devpanl.dev
# Expect: HTTP/2 200

# Test Bull Board (with auth)
curl -u admin:changeme123 https://queues.devpanl.dev
# Expect: HTML page

# Test Traefik dashboard (with auth)
curl -u admin:changeme123 https://traefik.devpanl.dev
# Expect: HTML dashboard
```

## Firewall Cloudflare (optionnel)

**Recommended rules:**

1. **Block known bots**
   - Expression: `(cf.client.bot)`
   - Action: Block

2. **Rate limit API**
   - Expression: `(http.request.uri.path contains "/api/")`
   - Rate: 100 req/min per IP
   - Action: Challenge

3. **Allow only specific countries** (optionnel)
   - Expression: `(ip.geoip.country ne "FR" and ip.geoip.country ne "US")`
   - Action: Block

4. **Block admin endpoints without auth**
   - Expression: `(http.request.uri.path contains "/api/admin" and not http.request.headers["x-admin-key"][0] eq "secret")`
   - Action: Block
   - Note: Ne fonctionne pas avec headers secrets, à utiliser avec IP whitelist

## Monitoring Cloudflare

**Analytics disponibles:**
- Requests per day/hour
- Bandwidth usage
- Threats blocked
- Status codes distribution
- Top countries/IPs
- Cache hit ratio

**Access:** Cloudflare Dashboard → devpanl.dev → Analytics
