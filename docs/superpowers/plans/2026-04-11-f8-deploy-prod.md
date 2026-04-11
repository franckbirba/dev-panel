# F8 — Deploy dev-panel to Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy dev-panel on a Hetzner CX22 VPS behind Cloudflare, with security hardening and GitHub Actions CI/CD.

**Architecture:** Hetzner CX22 (Ubuntu 24.04) runs Docker + Traefik as reverse proxy. Cloudflare proxies `devpanel.dev` with automatic TLS. GitHub Actions builds Docker images, pushes to GHCR, and deploys via SSH. The Express API is hardened with admin auth, CORS allowlist, rate limiting, and helmet headers.

**Tech Stack:** Node.js 22, Express, Docker, Traefik v3, Cloudflare, GitHub Actions, GHCR

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/server/index.js` | Modify | Add helmet, env-based CORS config |
| `src/server/routes.js` | Modify | Add admin auth middleware, rate limiting |
| `docker-compose.prod.yml` | Create | Production compose with GHCR image + Traefik |
| `.github/workflows/deploy.yml` | Create | CI/CD pipeline: build, push, deploy |
| `infra/traefik.yml` | Create | Traefik static config for VPS |
| `infra/dynamic.yml` | Create | Traefik dynamic config (HTTP→HTTPS redirect) |
| `infra/setup-vps.sh` | Create | One-time VPS bootstrap script |
| `package.json` | Modify | Add helmet, express-rate-limit deps |

---

### Task 1: Add security dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install helmet and express-rate-limit**

Run:
```bash
cd /Users/franckbirba/DEV/dev-panel
npm install helmet express-rate-limit
```

- [ ] **Step 2: Verify dependencies in package.json**

Run:
```bash
node -e "const p = JSON.parse(require('fs').readFileSync('package.json')); console.log(p.dependencies.helmet, p.dependencies['express-rate-limit'])"
```

Expected: version numbers for both packages.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add helmet and express-rate-limit dependencies"
```

---

### Task 2: Harden the Express server (index.js)

**Files:**
- Modify: `src/server/index.js`

- [ ] **Step 1: Add helmet and env-based CORS to createServer**

Replace the contents of `src/server/index.js` with:

```javascript
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { initMasterDatabase } from './db.js';
import { createRouter } from './routes.js';

export function createServer(storagePath = './storage') {
  // Initialize master database (projects.db)
  initMasterDatabase(storagePath);

  const config = {
    storagePath,
    server: { port: 3030, host: 'localhost' }
  };

  const app = express();

  // Security headers
  app.use(helmet());

  // CORS — restrict origins in production
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['*'];

  if (allowedOrigins.includes('*')) {
    app.use(cors());
  } else {
    app.use(cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (server-to-server, curl, etc.)
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      }
    }));
  }

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Routes
  app.use('/api', createRouter(config));

  return { app, config };
}

export function startServer(storagePath = './storage', port = 3030, host = 'localhost') {
  const { app } = createServer(storagePath);

  const server = app.listen(port, host, () => {
    console.log(`✓ DevPanel server running on http://${host}:${port}`);
    console.log(`✓ Storage: ${storagePath}`);
    console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
    if (process.env.ALLOWED_ORIGINS) {
      console.log(`✓ CORS: ${process.env.ALLOWED_ORIGINS}`);
    }
  });

  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });

  return server;
}
```

- [ ] **Step 2: Verify the server starts without errors**

Run:
```bash
node -e "import('./src/server/index.js').then(m => { const {app} = m.createServer('./storage'); console.log('OK'); process.exit(0); })"
```

Expected: `OK` with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/index.js
git commit -m "feat: add helmet security headers and env-based CORS"
```

---

### Task 3: Add admin auth and rate limiting to routes

**Files:**
- Modify: `src/server/routes.js:1-74` (imports + admin endpoints section)

- [ ] **Step 1: Add rate limiting import and admin auth middleware**

At the top of `src/server/routes.js`, replace the import block (lines 1-24) with:

```javascript
import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  getProjectByApiKey,
  createProject,
  listProjects,
  getProjectByName,
  initProjectDatabase,
  getProjectDatabase,
  createTicket,
  getTicket,
  listTickets,
  updateTicket,
  deleteTicket,
  getStats,
  upsertDoc,
  listDocs,
  searchDocs,
  getDocStats,
  upsertMilestone,
  listMilestones,
  listPendingClarifications,
  answerClarification
} from './db.js';
import { initGitHub, listIssues, getGitHub, fetchRepoDocs, fetchMilestones } from './github.js';
```

- [ ] **Step 2: Add rate limiters and admin middleware inside createRouter**

After line `const storagePath = config.storagePath || './storage';` (line 51), add:

```javascript
  // Rate limiters
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
  });

  const ticketCreateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many ticket submissions, please try again later.' }
  });

  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many auth attempts, please try again later.' }
  });

  // Apply global rate limit
  router.use(globalLimiter);

  // Admin authentication middleware
  function authenticateAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-key'];
    const configuredKey = process.env.ADMIN_API_KEY;

    if (!configuredKey) {
      // No admin key configured = admin endpoints disabled in production
      if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'Admin endpoints disabled. Set ADMIN_API_KEY.' });
      }
      // In dev, allow without key
      return next();
    }

    if (!adminKey || adminKey !== configuredKey) {
      return res.status(401).json({ error: 'Invalid or missing admin key. Provide via X-Admin-Key header.' });
    }

    next();
  }
```

- [ ] **Step 3: Protect admin endpoints with authenticateAdmin and authLimiter**

Replace the admin endpoints section (lines 62-167, from `// PROJECT MANAGEMENT` comment to end of import route) — add `authenticateAdmin` and `authLimiter` middleware:

Change:
```javascript
  router.get('/projects', (req, res) => {
```
To:
```javascript
  router.get('/projects', authLimiter, authenticateAdmin, (req, res) => {
```

Change:
```javascript
  router.post('/projects/import', async (req, res) => {
```
To:
```javascript
  router.post('/projects/import', authLimiter, authenticateAdmin, async (req, res) => {
```

- [ ] **Step 4: Add ticketCreateLimiter to ticket creation endpoint**

Change:
```javascript
  router.post('/tickets', authenticateProject, async (req, res) => {
```
To:
```javascript
  router.post('/tickets', ticketCreateLimiter, authenticateProject, async (req, res) => {
```

- [ ] **Step 5: Verify the server starts with the new middleware**

Run:
```bash
node -e "import('./src/server/index.js').then(m => { const {app} = m.createServer('./storage'); console.log('OK'); process.exit(0); })"
```

Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add src/server/routes.js
git commit -m "feat: add admin auth, rate limiting to API endpoints"
```

---

### Task 4: Create production docker-compose

**Files:**
- Create: `docker-compose.prod.yml`

- [ ] **Step 1: Create docker-compose.prod.yml**

```yaml
name: dev-panel-prod

services:
  devpanel:
    image: ghcr.io/franckbirba/dev-panel:latest
    container_name: devpanel-api
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./storage:/app/storage
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.devpanel.rule=Host(`devpanel.dev`)"
      - "traefik.http.routers.devpanel.entrypoints=websecure"
      - "traefik.http.routers.devpanel.tls=true"
      - "traefik.http.services.devpanel.loadbalancer.server.port=3030"
    networks:
      - traefik

  traefik:
    image: traefik:v3
    container_name: traefik
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./traefik:/etc/traefik
    networks:
      - traefik

networks:
  traefik:
    name: traefik
```

- [ ] **Step 2: Validate compose syntax**

Run:
```bash
docker compose -f docker-compose.prod.yml config --quiet
```

Expected: no output (valid config).

- [ ] **Step 3: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "feat: add production docker-compose with Traefik"
```

---

### Task 5: Create Traefik configuration for VPS

**Files:**
- Create: `infra/traefik.yml`
- Create: `infra/dynamic.yml`

- [ ] **Step 1: Create infra/traefik.yml (static config)**

```yaml
# Traefik static configuration for production VPS
api:
  dashboard: false

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
    http:
      tls: {}

providers:
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
  file:
    filename: "/etc/traefik/dynamic.yml"
    watch: true

log:
  level: "WARN"

accessLog: {}
```

- [ ] **Step 2: Create infra/dynamic.yml (Cloudflare TLS trust)**

```yaml
# Traefik dynamic configuration
# TLS is terminated at Cloudflare — Traefik receives HTTP from Cloudflare proxy
# No local TLS certificates needed when Cloudflare SSL mode is "Flexible"
# For "Full" mode, Cloudflare Origin CA cert can be added here later

http:
  middlewares:
    security-headers:
      headers:
        frameDeny: true
        browserXssFilter: true
        contentTypeNosniff: true
        forceSTSHeader: true
        stsSeconds: 31536000
        stsIncludeSubdomains: true
```

- [ ] **Step 3: Commit**

```bash
git add infra/
git commit -m "feat: add Traefik config for production VPS"
```

---

### Task 6: Create VPS bootstrap script

**Files:**
- Create: `infra/setup-vps.sh`

- [ ] **Step 1: Create infra/setup-vps.sh**

```bash
#!/bin/bash
set -euo pipefail

# ============================================================================
# dev-panel VPS Bootstrap Script
# Run as root on a fresh Ubuntu 24.04 Hetzner CX22
# Usage: ssh root@VPS_IP 'bash -s' < infra/setup-vps.sh
# ============================================================================

echo "=== Updating system ==="
apt-get update && apt-get upgrade -y

echo "=== Installing Docker ==="
curl -fsSL https://get.docker.com | sh

echo "=== Creating deploy user ==="
useradd -m -s /bin/bash -G docker deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys

# Allow deploy user to use docker without sudo
usermod -aG docker deploy

echo "=== Setting up project directory ==="
mkdir -p /home/deploy/dev-panel/storage
mkdir -p /home/deploy/dev-panel/traefik
chown -R deploy:deploy /home/deploy/dev-panel

echo "=== Configuring SSH hardening ==="
sed -i 's/#PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd

echo "=== Configuring unattended upgrades ==="
apt-get install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

echo "=== Done ==="
echo "Next steps:"
echo "  1. Copy docker-compose.prod.yml to /home/deploy/dev-panel/"
echo "  2. Copy infra/traefik.yml to /home/deploy/dev-panel/traefik/traefik.yml"
echo "  3. Copy infra/dynamic.yml to /home/deploy/dev-panel/traefik/dynamic.yml"
echo "  4. Create /home/deploy/dev-panel/.env with GITHUB_TOKEN, ADMIN_API_KEY, ALLOWED_ORIGINS, NODE_ENV"
echo "  5. Login to ghcr.io: docker login ghcr.io -u franckbirba"
echo "  6. Run: cd /home/deploy/dev-panel && docker compose -f docker-compose.prod.yml up -d"
```

- [ ] **Step 2: Make script executable**

Run:
```bash
chmod +x infra/setup-vps.sh
```

- [ ] **Step 3: Commit**

```bash
git add infra/setup-vps.sh
git commit -m "feat: add VPS bootstrap script"
```

---

### Task 7: Create GitHub Actions deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Create .github/workflows/deploy.yml**

```yaml
name: Deploy to Production

on:
  push:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=sha
            type=raw,value=latest

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}

      - name: Deploy to VPS
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: deploy
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd ~/dev-panel
            docker compose -f docker-compose.prod.yml pull
            docker compose -f docker-compose.prod.yml up -d --remove-orphans
            sleep 3
            curl -sf http://localhost:3030/api/health || (echo "Health check failed!" && exit 1)
            docker image prune -f
```

- [ ] **Step 2: Validate YAML syntax**

Run:
```bash
node -e "const fs = require('fs'); const y = fs.readFileSync('.github/workflows/deploy.yml', 'utf-8'); console.log(y.includes('on:') && y.includes('jobs:') ? 'VALID structure' : 'INVALID')"
```

Expected: `VALID structure`

- [ ] **Step 3: Commit**

```bash
git add .github/
git commit -m "feat: add GitHub Actions CI/CD deploy pipeline"
```

---

### Task 8: Create .env.example template

**Files:**
- Create: `.env.example`

- [ ] **Step 1: Create .env.example**

```bash
# dev-panel production environment variables
# Copy to .env and fill in values

# GitHub token for repo sync (required)
GITHUB_TOKEN=ghp_your_token_here

# Admin API key for /api/projects endpoints (required in production)
# Generate with: node -e "console.log('admin_' + require('crypto').randomBytes(32).toString('hex'))"
ADMIN_API_KEY=admin_your_key_here

# Comma-separated list of allowed CORS origins
ALLOWED_ORIGINS=https://devpanel.dev

# Node environment
NODE_ENV=production
```

- [ ] **Step 2: Ensure .env is gitignored**

Run:
```bash
echo ".env" >> .gitignore
```

If `.gitignore` doesn't exist, create it with:
```
.env
storage/
node_modules/
```

- [ ] **Step 3: Commit**

```bash
git add .env.example .gitignore
git commit -m "chore: add .env.example and .gitignore"
```

---

### Task 9: Manual infrastructure setup (not code)

These steps happen outside the codebase. Each step must be done manually.

- [ ] **Step 1: Provision Hetzner CX22**

Go to Hetzner Cloud console:
- Create server: CX22, Ubuntu 24.04, Falkenstein or Helsinki
- Add your SSH key
- Create firewall: allow TCP 22, 80, 443 inbound only
- Note the IP address

- [ ] **Step 2: Run VPS bootstrap**

```bash
ssh root@YOUR_VPS_IP 'bash -s' < infra/setup-vps.sh
```

- [ ] **Step 3: Copy configs to VPS**

```bash
scp docker-compose.prod.yml deploy@YOUR_VPS_IP:~/dev-panel/
scp infra/traefik.yml deploy@YOUR_VPS_IP:~/dev-panel/traefik/traefik.yml
scp infra/dynamic.yml deploy@YOUR_VPS_IP:~/dev-panel/traefik/dynamic.yml
```

- [ ] **Step 4: Create .env on VPS**

```bash
ssh deploy@YOUR_VPS_IP
cd ~/dev-panel
cp /dev/stdin .env << 'EOF'
GITHUB_TOKEN=ghp_your_real_token
ADMIN_API_KEY=$(node -e "console.log('admin_' + require('crypto').randomBytes(32).toString('hex'))")
ALLOWED_ORIGINS=https://devpanel.dev
NODE_ENV=production
EOF
```

- [ ] **Step 5: Login to GHCR on VPS**

```bash
ssh deploy@YOUR_VPS_IP
echo "YOUR_GITHUB_PAT" | docker login ghcr.io -u franckbirba --password-stdin
```

- [ ] **Step 6: Configure Cloudflare DNS**

In Cloudflare dashboard for `devpanel.dev`:
- Add A record: `@` → VPS IP, Proxy ON (orange cloud)
- SSL/TLS mode: Full

- [ ] **Step 7: Add GitHub repo secrets**

In GitHub repo Settings → Secrets → Actions:
- `VPS_HOST`: your VPS IP
- `VPS_SSH_KEY`: private key for `deploy` user (generate a dedicated key pair)

- [ ] **Step 8: First deploy**

Push to main to trigger the pipeline, or manually:
```bash
ssh deploy@YOUR_VPS_IP
cd ~/dev-panel
docker compose -f docker-compose.prod.yml up -d
```

- [ ] **Step 9: Verify production**

```bash
curl -s https://devpanel.dev/api/health
```

Expected:
```json
{"status":"ok","timestamp":"..."}
```

Test admin auth:
```bash
# Should fail (no admin key)
curl -s https://devpanel.dev/api/projects
# Should succeed
curl -s -H "X-Admin-Key: your_admin_key" https://devpanel.dev/api/projects
```
