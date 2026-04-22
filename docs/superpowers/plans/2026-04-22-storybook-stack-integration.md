# Storybook Stack Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a shared Storybook instance at `ui.devpanl.dev` that catalogues UI components for every project in Franck's studio (dev-panel, zeno, edms, candidat), with per-project stories rsync'd from each repo's `stories/` folder by a reusable GitHub workflow.

**Architecture:** New `storybook` service in `docker-compose.yml` under `[core, all]` profiles. Dev-mode Storybook 8 container reads stories read-only from a shared Docker volume. A reusable GitHub workflow (`workflow_call`) in the dev-panel repo rsyncs a caller repo's `stories/` folder into a project-scoped subdirectory on the services VPS. Plugin updates in `devpanl-claude-plugin` teach agents where to put stories. Detailed spec: `docs/superpowers/specs/2026-04-22-storybook-stack-integration-design.md`.

**Tech Stack:** Storybook 8 (`@storybook/react-vite`), React 19, Node 20 slim, Traefik (existing), rsync over SSH, GitHub Actions reusable workflows.

---

## File Structure

**Files created in dev-panel:**

- `infra/storybook/Dockerfile` — node:20-slim image that runs `storybook dev` on port 6006
- `infra/storybook/package.json` — storybook@8, @storybook/react-vite, react@19, vite@6
- `infra/storybook/.storybook/main.js` — stories glob + framework config
- `infra/storybook/.storybook/preview.js` — global parameters
- `infra/storybook/.storybook/manager.js` — sidebar grouping
- `infra/storybook/index.html` — vite entry
- `infra/storybook/README.md` — what this folder is, how to run it locally
- `.github/workflows/storybook-image.yml` — builds + pushes storybook image on infra/storybook/** changes
- `.github/workflows/sync-stories.yml` — reusable `workflow_call` that rsyncs `stories/` into the VPS volume
- `infra/scripts/bootstrap/storybook-sync-user.sh` — idempotent script creating the `storybook-sync` system user on services VPS
- `stories/devpanel/tokens.mdx` — design tokens table
- `stories/devpanel/Button.stories.jsx` — seeded primitive story
- `stories/devpanel/StatusChip.stories.jsx` — seeded component story
- `stories/devpanel/MetricCard.stories.jsx` — seeded component story
- `stories/devpanel/SignalRow.stories.jsx` — seeded component story
- `stories-shared/tokens.mdx` — cross-project shared tokens

**Files modified in dev-panel:**

- `docker-compose.yml` — new `storybook` service + `storybook-stories` volume
- `.github/workflows/deploy.yml` — rsync dev-panel's own `stories/` + `stories-shared/` after deploy
- `Makefile` — add `storybook-dev` target for local use
- `CLAUDE.md` — one-paragraph section pointing agents at `ui.devpanl.dev` and the authoring skill

**Files created in `devpanl-claude-plugin`:**

- `skills/storybook-authoring.md` — rules for where stories live, naming, import constraints

**Files modified in `devpanl-claude-plugin`:**

- `skills/devpanl-readiness.md` — add storybook readiness check
- `commands/init.md` — scaffold `stories/.keep` + caller workflow

---

## Task 1: Scaffold the Storybook container folder

**Files:**
- Create: `infra/storybook/package.json`
- Create: `infra/storybook/.storybook/main.js`
- Create: `infra/storybook/.storybook/preview.js`
- Create: `infra/storybook/.storybook/manager.js`
- Create: `infra/storybook/index.html`
- Create: `infra/storybook/README.md`

- [ ] **Step 1: Create `infra/storybook/package.json`**

```json
{
  "name": "devpanl-storybook",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "storybook": "storybook dev -p 6006 --no-open --host 0.0.0.0"
  },
  "dependencies": {
    "react": "^19.2.5",
    "react-dom": "^19.2.5"
  },
  "devDependencies": {
    "@storybook/addon-essentials": "^8.6.0",
    "@storybook/react-vite": "^8.6.0",
    "storybook": "^8.6.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create `infra/storybook/.storybook/main.js`**

```js
/** @type { import('@storybook/react-vite').StorybookConfig } */
const config = {
  stories: ['/stories/**/*.mdx', '/stories/**/*.stories.@(js|jsx|ts|tsx)'],
  addons: ['@storybook/addon-essentials'],
  framework: {
    name: '@storybook/react-vite',
    options: {}
  },
  core: {
    disableTelemetry: true,
    disableWhatsNewNotifications: true
  }
};

export default config;
```

- [ ] **Step 3: Create `infra/storybook/.storybook/preview.js`**

```js
/** @type { import('@storybook/react').Preview } */
const preview = {
  parameters: {
    backgrounds: {
      default: 'devpanel-dark',
      values: [
        { name: 'devpanel-dark', value: '#0A0A0B' },
        { name: 'light', value: '#FFFFFF' }
      ]
    },
    options: {
      storySort: {
        order: ['shared', 'devpanel', 'zeno', 'edms', 'candidat', '*']
      }
    }
  }
};

export default preview;
```

- [ ] **Step 4: Create `infra/storybook/.storybook/manager.js`**

```js
import { addons } from '@storybook/manager-api';

addons.setConfig({
  sidebar: {
    showRoots: true
  }
});
```

- [ ] **Step 5: Create `infra/storybook/index.html`**

```html
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>devpanl UI catalogue</title></head>
  <body></body>
</html>
```

- [ ] **Step 6: Create `infra/storybook/README.md`**

```md
# devpanl Storybook

Shared UI catalogue for all studio projects. Deployed as the `storybook`
service in docker-compose.yml under the [core, all] profiles; browsable at
https://ui.devpanl.dev.

Stories are NOT kept in this folder. They live in the `stories/` folder of
each consuming project's repo and are rsync'd into the shared volume
`storybook-stories` on every push to main via
`.github/workflows/sync-stories.yml`.

Run locally against this repo's `stories/` folder:

    make storybook-dev
```

- [ ] **Step 7: Commit**

```bash
git add infra/storybook/
git commit -m "feat(storybook): scaffold storybook-8 container folder"
```

---

## Task 2: Dockerfile for the Storybook image

**Files:**
- Create: `infra/storybook/Dockerfile`

- [ ] **Step 1: Create `infra/storybook/Dockerfile`**

```dockerfile
FROM node:20-slim

WORKDIR /app

# Install storybook deps once, cached in the image layer.
COPY package.json ./
RUN npm install --no-audit --no-fund

# Minimal storybook config — stories come from a mounted volume at /stories.
COPY .storybook ./.storybook
COPY index.html ./

# Create the mount point so storybook's glob resolves to an existing dir
# even before the sync user has written anything.
RUN mkdir -p /stories && chown -R node:node /stories /app

USER node

EXPOSE 6006

# Dev mode so new stories in /stories are picked up on reload — no rebuild.
CMD ["npm", "run", "storybook"]
```

- [ ] **Step 2: Build the image locally to catch config errors**

Run:
```bash
docker build -t devpanl-storybook:test infra/storybook/
```
Expected: successful build, final line `naming to docker.io/library/devpanl-storybook:test`.

- [ ] **Step 3: Smoke-run the image with an empty stories dir**

Run:
```bash
mkdir -p /tmp/empty-stories
docker run --rm -d --name sb-test -p 6006:6006 -v /tmp/empty-stories:/stories:ro devpanl-storybook:test
sleep 20
curl -sf http://localhost:6006/ > /dev/null && echo "storybook up" || echo "storybook DOWN"
docker logs sb-test 2>&1 | tail -20
docker stop sb-test
```
Expected: `storybook up`, logs show `Storybook 8.x.x for react-vite started` on port 6006.

- [ ] **Step 4: Commit**

```bash
git add infra/storybook/Dockerfile
git commit -m "feat(storybook): Dockerfile for dev-mode catalogue container"
```

---

## Task 3: Seed dev-panel stories — tokens MDX

**Files:**
- Create: `stories/devpanel/tokens.mdx`
- Create: `stories-shared/tokens.mdx`

- [ ] **Step 1: Read the existing tokens source so values stay in sync**

Run:
```bash
cat src/dashboard/theme.js
```
Note the `colors`, `fonts`, `spacing`, `radii` exports — they feed the MDX below.

- [ ] **Step 2: Create `stories/devpanel/tokens.mdx`**

```mdx
import { Meta } from '@storybook/blocks';

<Meta title="devpanel/Tokens" />

# Design Tokens — dev-panel

Source of truth: `src/dashboard/theme.js`. Agents copy CSS variables from
this table; never invent new colors or spacing values.

## Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `bg` | `#0A0A0B` | App background |
| `card` | `#13131A` | Card surface |
| `elevated` | `#1C1C26` | Modal, popover, raised surface |
| `border` | `#2A2A3A` | Default border |
| `textPrimary` | `#E8E8ED` | Body text |
| `textSecondary` | `#8B8B9B` | Labels, metadata |
| `textMuted` | `#6B6B7B` | Captions, helper text |
| `textDim` | `#4B4B5B` | Disabled, placeholder |
| `success` | `#10B981` | Success state |
| `warning` | `#F59E0B` | Warning state |
| `error` | `#EF4444` | Error, destructive |
| `info` | `#3B82F6` | Informational |

## Typography

| Role | Stack |
|------|-------|
| Headline | `'Epilogue', sans-serif` (400/600/700) |
| Body | `'IBM Plex Sans', sans-serif` (400/500/600/700) |
| Mono | `'IBM Plex Mono', monospace` (400/500/700) |

## Spacing

| Token | Value |
|-------|-------|
| `xs` | 4px |
| `sm` | 8px |
| `md` | 16px |
| `lg` | 24px |
| `xl` | 32px |

## Radii

| Token | Value |
|-------|-------|
| `sm` | 4px |
| `md` | 6px |
| `lg` | 10px |
| `xl` | 14px |
```

- [ ] **Step 3: Create `stories-shared/tokens.mdx` (identical content, shared namespace)**

```mdx
import { Meta } from '@storybook/blocks';

<Meta title="shared/Tokens" />

# Shared Tokens — devpanl studio

Cross-project vocabulary. Every app (dev-panel, zeno, edms, candidat)
starts from these values and deviates only with explicit reason.

## Colors

| Token | Hex |
|-------|-----|
| `bg` | `#0A0A0B` |
| `card` | `#13131A` |
| `elevated` | `#1C1C26` |
| `border` | `#2A2A3A` |
| `textPrimary` | `#E8E8ED` |
| `textSecondary` | `#8B8B9B` |
| `textMuted` | `#6B6B7B` |
| `textDim` | `#4B4B5B` |
| `success` | `#10B981` |
| `warning` | `#F59E0B` |
| `error` | `#EF4444` |
| `info` | `#3B82F6` |

## Typography

- **Headline:** Epilogue (400/600/700)
- **Body:** IBM Plex Sans (400/500/600/700)
- **Mono:** IBM Plex Mono (400/500/700)

## Spacing scale

`xs 4 · sm 8 · md 16 · lg 24 · xl 32` (px)

## Radii

`sm 4 · md 6 · lg 10 · xl 14` (px)
```

- [ ] **Step 4: Commit**

```bash
git add stories/devpanel/tokens.mdx stories-shared/tokens.mdx
git commit -m "feat(storybook): seed tokens MDX for devpanel + shared"
```

---

## Task 4: Seed dev-panel stories — four component stories

**Files:**
- Read to stay accurate: `src/dashboard/components/status-chip.jsx`, `metric-card.jsx`, `signal-row.jsx` (and any Button in use)
- Create: `stories/devpanel/Button.stories.jsx`
- Create: `stories/devpanel/StatusChip.stories.jsx`
- Create: `stories/devpanel/MetricCard.stories.jsx`
- Create: `stories/devpanel/SignalRow.stories.jsx`

- [ ] **Step 1: Inspect each component to match actual props**

Run:
```bash
head -40 src/dashboard/components/status-chip.jsx
head -40 src/dashboard/components/metric-card.jsx
head -40 src/dashboard/components/signal-row.jsx
grep -rE "export (default|const) [A-Z]" src/dashboard/components/ | grep -i button
```
Write down the real prop names and variants before coding the stories — the code below uses best-guess shapes, adapt to what you see.

- [ ] **Step 2: Create `stories/devpanel/Button.stories.jsx`**

If no `Button` component exists in `src/dashboard/components`, skip this story and add a TODO note in the PR description — do not invent a component. If one exists, match its real API. Template:

```jsx
import React from 'react';
import { Button } from '../../src/dashboard/components/button.jsx';

export default {
  title: 'devpanel/Button',
  component: Button
};

export const Primary = { args: { children: 'Primary action', variant: 'primary' } };
export const Secondary = { args: { children: 'Secondary', variant: 'secondary' } };
export const Danger = { args: { children: 'Delete', variant: 'danger' } };
export const Disabled = { args: { children: 'Disabled', disabled: true } };
```

- [ ] **Step 3: Create `stories/devpanel/StatusChip.stories.jsx`**

```jsx
import React from 'react';
import { StatusChip } from '../../src/dashboard/components/status-chip.jsx';

export default {
  title: 'devpanel/StatusChip',
  component: StatusChip,
  parameters: { backgrounds: { default: 'devpanel-dark' } }
};

export const New = { args: { status: 'new' } };
export const Triaging = { args: { status: 'triaging' } };
export const Promoted = { args: { status: 'promoted' } };
export const Dropped = { args: { status: 'dropped' } };
```

Adjust `status` values to whatever the real component accepts (check with `grep -n "status ===" src/dashboard/components/status-chip.jsx`).

- [ ] **Step 4: Create `stories/devpanel/MetricCard.stories.jsx`**

```jsx
import React from 'react';
import { MetricCard } from '../../src/dashboard/components/metric-card.jsx';

export default {
  title: 'devpanel/MetricCard',
  component: MetricCard,
  parameters: { backgrounds: { default: 'devpanel-dark' } }
};

export const Default = {
  args: { label: 'Captures today', value: 14, trend: '+3 vs yesterday' }
};

export const Warning = {
  args: { label: 'Failed jobs', value: 2, tone: 'warning' }
};

export const Empty = {
  args: { label: 'Shipped', value: 0, tone: 'muted' }
};
```

Match prop names to the actual component.

- [ ] **Step 5: Create `stories/devpanel/SignalRow.stories.jsx`**

```jsx
import React from 'react';
import { SignalRow } from '../../src/dashboard/components/signal-row.jsx';

export default {
  title: 'devpanel/SignalRow',
  component: SignalRow,
  parameters: { backgrounds: { default: 'devpanel-dark' } }
};

export const CaptureNew = {
  args: {
    signal: {
      id: 'cap_123',
      type: 'capture',
      title: 'Dashboard sidebar breaks on narrow viewport',
      status: 'new',
      createdAt: '2026-04-22T09:12:00Z'
    }
  }
};

export const JobFailed = {
  args: {
    signal: {
      id: 'job_789',
      type: 'job',
      title: 'Deploy zeno — npm test failed',
      status: 'failed',
      createdAt: '2026-04-22T08:45:00Z'
    }
  }
};
```

Match the real shape of the `signal` object — check `src/dashboard/lib/use-signals.js` for the canonical schema.

- [ ] **Step 6: Verify stories render against a local Storybook**

Run:
```bash
docker run --rm -d --name sb-seed -p 6006:6006 \
  -v "$(pwd)/stories:/stories/devpanel:ro" \
  -v "$(pwd)/stories-shared:/stories/shared:ro" \
  devpanl-storybook:test
sleep 20
curl -sf http://localhost:6006/index.html > /dev/null && echo "up" || echo "DOWN"
docker logs sb-seed 2>&1 | grep -iE "error|story|loaded" | head -10
docker stop sb-seed
```

Expected: `up`; logs show the 5 story files loaded and no errors. If errors appear, fix the corresponding story before committing.

- [ ] **Step 7: Commit**

```bash
git add stories/devpanel/ stories-shared/
git commit -m "feat(storybook): seed devpanel + shared stories"
```

---

## Task 5: Add `storybook` service to docker-compose.yml

**Files:**
- Modify: `docker-compose.yml` (append service before the `VOLUMES & NETWORKS` section, add volume name to the `volumes:` block)

- [ ] **Step 1: Add the service block before the `# VOLUMES & NETWORKS` divider**

Find the comment header:
```
# ══════════════════════════════════════════════════════════════════════════
# VOLUMES & NETWORKS
```

Immediately above it, add:

```yaml
  # ──────────────────────────────────────────────────────────────────────
  # Storybook — shared UI catalogue for every studio project
  # Stories arrive via rsync from each project's repo on every push to main
  # ──────────────────────────────────────────────────────────────────────
  storybook:
    image: ghcr.io/franckbirba/devpanl-storybook:latest
    container_name: devpanel-storybook
    profiles: [core, all]
    restart: unless-stopped
    volumes:
      - storybook-stories:/stories:ro
    networks:
      - devpanel_net
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.storybook.rule=Host(`ui.devpanl.dev`)"
      - "traefik.http.routers.storybook.entrypoints=websecure"
      - "traefik.http.routers.storybook.tls.certresolver=le"
      - "traefik.http.services.storybook.loadbalancer.server.port=6006"
      - "traefik.http.routers.storybook.middlewares=storybook-auth"
      - "traefik.http.middlewares.storybook-auth.basicauth.usersfile=/etc/traefik/.htpasswd"
```

- [ ] **Step 2: Add `storybook-stories:` to the `volumes:` block**

Find:
```yaml
volumes:
  traefik-certs:
  redis-data:
  ...
  uptime-kuma-data:
```

Change to:
```yaml
volumes:
  traefik-certs:
  redis-data:
  postgres-data:
  affine-config:
  affine-storage:
  plane-pgdata:
  plane-redisdata:
  plane-minio-data:
  penpot-assets:
  penpot-plugins:
  penpot-pgdata:
  uptime-kuma-data:
  storybook-stories:
```

- [ ] **Step 3: Validate the compose file parses**

Run:
```bash
docker compose --profile core config > /tmp/compose-validation.yml
grep -E "^  storybook:|storybook-stories:" /tmp/compose-validation.yml
```
Expected: both lines appear. If `docker compose config` exits non-zero, fix YAML syntax before committing.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(compose): add storybook service under [core, all] profiles"
```

---

## Task 6: Workflow to build and push the Storybook image to GHCR

**Files:**
- Create: `.github/workflows/storybook-image.yml`

- [ ] **Step 1: Create `.github/workflows/storybook-image.yml`**

```yaml
name: Build Storybook Image

on:
  push:
    branches: [main]
    paths:
      - 'infra/storybook/**'
      - '.github/workflows/storybook-image.yml'
  workflow_dispatch:

env:
  REGISTRY: ghcr.io
  IMAGE: franckbirba/devpanl-storybook

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: infra/storybook
          push: true
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE }}:latest
            ${{ env.REGISTRY }}/${{ env.IMAGE }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Validate the workflow parses**

Run (requires `yq` or just a python one-liner — use whichever is installed):
```bash
python3 -c "import yaml,sys;yaml.safe_load(open('.github/workflows/storybook-image.yml'))" && echo "ok"
```
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/storybook-image.yml
git commit -m "ci(storybook): build and push image to GHCR on infra/storybook changes"
```

---

## Task 7: Reusable workflow — sync stories to the VPS volume

**Files:**
- Create: `.github/workflows/sync-stories.yml`

- [ ] **Step 1: Create `.github/workflows/sync-stories.yml`**

```yaml
name: Sync Stories to devpanl Storybook

on:
  workflow_call:
    inputs:
      project-slug:
        description: "Subdirectory name under /stories/ (e.g. zeno, edms, candidat). Lowercase, hyphen-safe."
        required: true
        type: string
      stories-path:
        description: "Path in the caller repo that holds the stories tree. Defaults to 'stories'."
        required: false
        type: string
        default: "stories"
    secrets:
      SYNC_SSH_KEY:
        description: "Private SSH key for the storybook-sync user on the services VPS."
        required: true
      SYNC_HOST:
        description: "Services VPS host (e.g. services.devpanl.dev or IP)."
        required: true

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Validate inputs
        run: |
          slug='${{ inputs.project-slug }}'
          if ! printf '%s' "$slug" | grep -Eq '^[a-z0-9][a-z0-9-]{0,30}$'; then
            echo "ERROR: project-slug must match ^[a-z0-9][a-z0-9-]{0,30}\$ — got '$slug'"
            exit 1
          fi
          if [ ! -d '${{ inputs.stories-path }}' ]; then
            echo "ERROR: stories path '${{ inputs.stories-path }}' does not exist in the repo"
            exit 1
          fi

      - name: Configure SSH
        run: |
          mkdir -p ~/.ssh
          echo "${{ secrets.SYNC_SSH_KEY }}" > ~/.ssh/id_ed25519
          chmod 600 ~/.ssh/id_ed25519
          ssh-keyscan -H '${{ secrets.SYNC_HOST }}' >> ~/.ssh/known_hosts 2>/dev/null

      - name: Rsync stories
        run: |
          rsync -av --delete \
            -e "ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=yes" \
            '${{ inputs.stories-path }}/' \
            'storybook-sync@${{ secrets.SYNC_HOST }}:${{ inputs.project-slug }}/'

      - name: Report
        run: |
          echo "Synced '${{ inputs.stories-path }}/' → ${{ inputs.project-slug }}/ on ${{ secrets.SYNC_HOST }}"
          echo "Catalogue: https://ui.devpanl.dev"
```

The SSH endpoint is chrooted at `/var/lib/devpanl/storybook-stories/<slug>/` server-side (see Task 8), so the relative path in the rsync target is intentional.

- [ ] **Step 2: Validate YAML parses**

Run:
```bash
python3 -c "import yaml,sys;yaml.safe_load(open('.github/workflows/sync-stories.yml'))" && echo "ok"
```
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/sync-stories.yml
git commit -m "ci(storybook): reusable workflow to rsync project stories"
```

---

## Task 8: VPS bootstrap script for the `storybook-sync` user

**Files:**
- Create: `infra/scripts/bootstrap/storybook-sync-user.sh`

- [ ] **Step 1: Create `infra/scripts/bootstrap/storybook-sync-user.sh`**

```bash
#!/usr/bin/env bash
# Idempotent: provision the storybook-sync system user on the services VPS.
# Run as root on the services VPS. Safe to re-run.
#
# What it does:
#   1. Creates user 'storybook-sync' with no login shell.
#   2. Creates /var/lib/devpanl/storybook-stories/ owned by that user.
#   3. Installs authorized_keys with command= restriction that pins rsync
#      into a per-project subdirectory chosen by the caller workflow.
#
# Per-project SSH keys are added as additional entries. Each entry pins
# rsync to a specific subdirectory so a leak in project A's key cannot
# overwrite project B's stories.
set -euo pipefail

USER_NAME="storybook-sync"
HOME_DIR="/var/lib/devpanl/storybook-stories"
AUTH_KEYS="$HOME_DIR/.ssh/authorized_keys"

if ! id "$USER_NAME" &>/dev/null; then
  useradd --system \
    --home-dir "$HOME_DIR" \
    --create-home \
    --shell /usr/sbin/nologin \
    "$USER_NAME"
  echo "Created system user $USER_NAME"
else
  echo "User $USER_NAME already exists"
fi

mkdir -p "$HOME_DIR/.ssh"
chown -R "$USER_NAME:$USER_NAME" "$HOME_DIR"
chmod 700 "$HOME_DIR/.ssh"

touch "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"
chown "$USER_NAME:$USER_NAME" "$AUTH_KEYS"

cat <<'HELP'

Next steps — manual, per project:

  1. Generate a project-specific keypair on the developer machine:
       ssh-keygen -t ed25519 -f ~/.ssh/storybook-sync-<project> -N ''

  2. Store the PRIVATE key as the caller repo's SYNC_SSH_KEY secret.

  3. Append the PUBLIC key to this host's authorized_keys, gated by a
     command= restriction that pins rsync to /<project>/:

       command="rrsync -wo /var/lib/devpanl/storybook-stories/<project>",
       no-agent-forwarding,no-port-forwarding,no-pty,no-X11-forwarding
       ssh-ed25519 AAAA... user@host

     (rrsync ships with rsync; on Debian/Ubuntu:
        /usr/share/doc/rsync/scripts/rrsync )

  4. Create the project subdirectory:
       install -d -o storybook-sync -g storybook-sync \
         /var/lib/devpanl/storybook-stories/<project>

  5. Bind the storybook container so its /stories/ mount includes the
     new subdirectory. Since the compose volume covers the whole parent
     folder, no change is needed — the new dir appears immediately.

HELP

echo "Done. See the block above for per-project onboarding."
```

- [ ] **Step 2: Make it executable**

Run:
```bash
chmod +x infra/scripts/bootstrap/storybook-sync-user.sh
```

- [ ] **Step 3: Shellcheck the script (if shellcheck is installed; otherwise skip)**

Run:
```bash
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck infra/scripts/bootstrap/storybook-sync-user.sh && echo "ok"
else
  echo "shellcheck not installed — skipping"
fi
```
Expected: `ok` or skip.

- [ ] **Step 4: Commit**

```bash
git add infra/scripts/bootstrap/storybook-sync-user.sh
git commit -m "feat(infra): bootstrap script for storybook-sync system user"
```

---

## Task 9: Local dev Makefile target

**Files:**
- Modify: `Makefile`

- [ ] **Step 1: Append a `storybook-dev` target to the Makefile**

Append at the bottom of `Makefile`:

```makefile

# ──────────────────────────────────────────────────────────────────────
# Storybook (local)
# ──────────────────────────────────────────────────────────────────────

.PHONY: storybook-dev
storybook-dev:
	@echo "Running storybook against ./stories and ./stories-shared"
	@docker build -t devpanl-storybook:local infra/storybook/
	@docker run --rm -it -p 6006:6006 \
		-v "$(PWD)/stories:/stories/devpanel:ro" \
		-v "$(PWD)/stories-shared:/stories/shared:ro" \
		devpanl-storybook:local
```

- [ ] **Step 2: Smoke-run the target**

Run:
```bash
make storybook-dev &
MAKE_PID=$!
sleep 30
curl -sf http://localhost:6006/index.html > /dev/null && echo "local storybook up" || echo "DOWN"
kill $MAKE_PID 2>/dev/null || true
docker ps --filter ancestor=devpanl-storybook:local -q | xargs -r docker stop
```
Expected: `local storybook up`.

- [ ] **Step 3: Commit**

```bash
git add Makefile
git commit -m "feat(make): storybook-dev target for local catalogue"
```

---

## Task 10: Sync dev-panel's own stories on production deploy

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Open `.github/workflows/deploy.yml` and find the existing `deploy-core` job's SSH step**

Locate the `appleboy/ssh-action@v1` step inside `deploy-core` — that's where other post-deploy ops run.

- [ ] **Step 2: Add a new job at the end of the file that calls the reusable sync workflow**

Append at the end of `.github/workflows/deploy.yml`:

```yaml
  sync-devpanel-stories:
    needs: deploy-core
    uses: ./.github/workflows/sync-stories.yml
    with:
      project-slug: devpanel
      stories-path: stories
    secrets:
      SYNC_SSH_KEY: ${{ secrets.STORYBOOK_SYNC_SSH_KEY }}
      SYNC_HOST: ${{ secrets.VPS_HOST }}

  sync-shared-stories:
    needs: deploy-core
    uses: ./.github/workflows/sync-stories.yml
    with:
      project-slug: shared
      stories-path: stories-shared
    secrets:
      SYNC_SSH_KEY: ${{ secrets.STORYBOOK_SYNC_SSH_KEY }}
      SYNC_HOST: ${{ secrets.VPS_HOST }}
```

- [ ] **Step 3: Validate YAML parses**

Run:
```bash
python3 -c "import yaml;yaml.safe_load(open('.github/workflows/deploy.yml'))" && echo "ok"
```
Expected: `ok`.

- [ ] **Step 4: Document the two new required secrets in CLAUDE.md or infra/docs/README.md**

Append to `infra/docs/README.md` (if it exists; if not, create a short `infra/docs/STORYBOOK.md`):

```md
## Storybook sync

Required GitHub secrets on the dev-panel repo and every caller repo:

- `STORYBOOK_SYNC_SSH_KEY` — private key for the `storybook-sync` user on
  the services VPS, pinned to the project's subdir via rrsync.
- `VPS_HOST` — already set for core deploy; reused here.

The `storybook-sync` user is provisioned once by
`infra/scripts/bootstrap/storybook-sync-user.sh` (run as root on the
services VPS). Follow the HELP text it prints for per-project onboarding.
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml infra/docs/
git commit -m "ci(deploy): sync devpanel + shared stories after deploy-core"
```

---

## Task 11: Point agents at Storybook from CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append a short section to `CLAUDE.md`**

Add at the end of the file:

```md
## UI catalogue — ui.devpanl.dev

Before building any UI in any studio project, check the catalogue at
https://ui.devpanl.dev (htpasswd: same credentials as bull-board / affine).
It lists:

- Shared design tokens (colors, spacing, radii, typography) under `shared/`.
- Per-project components under `devpanel/`, `zeno/`, `edms/`, `candidat/`.

Authoring rule: each project's stories live in its repo under `stories/`
and are synced to the catalogue on every push to main by the reusable
`sync-stories.yml` workflow. Full authoring conventions:
`skills/storybook-authoring.md` in the `devpanl-claude-plugin` repo.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): point agents at ui.devpanl.dev catalogue"
```

---

## Task 12: Plugin — `storybook-authoring` skill

**Files (in `devpanl-claude-plugin` repo, clone at `/Users/franckbirba/.claude/plugins/marketplaces/devpanl-claude-plugin`):**
- Create: `skills/storybook-authoring.md`

- [ ] **Step 1: Switch to the plugin repo**

Run:
```bash
cd /Users/franckbirba/.claude/plugins/marketplaces/devpanl-claude-plugin
git status
```
Expected: clean working tree on `main`.

- [ ] **Step 2: Create `skills/storybook-authoring.md`**

```md
---
name: storybook-authoring
description: Use when writing UI components in any devpanl studio project. Defines where stories live, naming rules, import constraints, and how stories reach the shared catalogue at ui.devpanl.dev.
---

# Storybook authoring for devpanl projects

Every studio project (dev-panel, zeno, edms, candidat, …) publishes its
UI to a single shared Storybook at **https://ui.devpanl.dev**. Before
writing a new component, browse the catalogue. If a pattern exists, copy
its implementation into your project. Do not invent a second Button.

## Where stories live

At the root of the project repo, in `stories/`. Mirror the component
hierarchy:

    stories/
      tokens.mdx                (tokens doc, one per project)
      Button.stories.jsx
      forms/
        LoginForm.stories.jsx

## Naming

- Story titles use the project slug as the top-level category:
  `title: 'zeno/Button'` (not `'Button'`, not `'Components/Button'`).
- `shared/` is reserved for cross-project tokens + primitives that live
  in dev-panel's `stories-shared/`. Never write to `shared/` from a
  non-devpanel project.

## Import rule

A story imports components by **relative path from the same repo only**.

    // OK
    import { Button } from '../src/components/button.jsx';

    // NEVER
    import { Button } from '@devpanl/ui';
    import { Button } from '../../dev-panel/src/...';

Storybook is a catalogue, not a module graph. If you see a pattern in
another project's section, copy the code into your repo; do not try to
import across projects.

## How stories reach the catalogue

On every push to `main`, the repo's `.github/workflows/sync-stories.yml`
caller workflow rsyncs `stories/` into the shared volume. No manual
upload, no API, no dashboard button. Git is the source of truth.

To enable sync in a new project, add this file at
`.github/workflows/sync-stories.yml`:

    name: Sync stories
    on:
      push:
        branches: [main]
        paths: ['stories/**']
    jobs:
      sync:
        uses: franckbirba/dev-panel/.github/workflows/sync-stories.yml@main
        with:
          project-slug: <your-project-slug>
        secrets:
          SYNC_SSH_KEY: ${{ secrets.STORYBOOK_SYNC_SSH_KEY }}
          SYNC_HOST: ${{ secrets.VPS_HOST }}

The two secrets must exist on the caller repo. Ask in #infra if you
don't have them.

## Tokens

Every project's first story is `stories/tokens.mdx`, a table of the
project's colors, spacing, radii, and typography. Seed it from
`stories-shared/tokens.mdx` in dev-panel; only deviate with an explicit
reason recorded in the MDX.

## Don't

- Don't add a `package.json` or `node_modules/` under `stories/` — the
  Storybook container provides React and Storybook itself.
- Don't write stories that fetch live data from the API. Use fixtures.
- Don't commit screenshots alongside stories; Storybook renders the
  component directly.
```

- [ ] **Step 3: Commit in the plugin repo**

```bash
git add skills/storybook-authoring.md
git commit -m "feat(skill): storybook-authoring — authoring rules for the shared catalogue"
```

---

## Task 13: Plugin — update `devpanl-readiness` check

**Files:**
- Modify: `skills/devpanl-readiness.md` (in the plugin repo)

- [ ] **Step 1: Read the current file to know where to add**

Run (still inside the plugin repo):
```bash
cat skills/devpanl-readiness.md
```
Note the section style — add a new check in the same format.

- [ ] **Step 2: Append a new readiness check**

Append before the final closing marker (or at the end of the file if there is none):

```md

## Check: Storybook authoring is wired

A project is storybook-ready when:

1. It has a `stories/` folder at the repo root (even if only `.keep` for
   now — signals intent and prevents the sync workflow from failing).
2. It has `.github/workflows/sync-stories.yml` invoking the reusable
   workflow from dev-panel with a valid `project-slug`.
3. The repo secrets `STORYBOOK_SYNC_SSH_KEY` and `VPS_HOST` are set.

If any of those are missing, flag it. Fix path: re-run `/devpanl:init`,
which now scaffolds the folder and caller workflow.
```

- [ ] **Step 3: Commit in the plugin repo**

```bash
git add skills/devpanl-readiness.md
git commit -m "feat(readiness): storybook authoring check"
```

---

## Task 14: Plugin — update `/devpanl:init` to scaffold stories

**Files:**
- Modify: `commands/init.md` (in the plugin repo)

- [ ] **Step 1: Read the current file**

Run:
```bash
cat commands/init.md
```
Locate where it creates folders / writes files.

- [ ] **Step 2: Add two scaffolding steps**

Append before the final `Done.` line (or equivalent terminator):

````md

### Scaffold Storybook authoring

Agents and humans in this project will author stories in `stories/`. The
catalogue lives at https://ui.devpanl.dev and pulls stories on every
push to main.

1. Create `stories/.keep` if `stories/` does not yet exist, so git
   tracks the folder even empty.

2. Create `.github/workflows/sync-stories.yml` with:

```yaml
name: Sync stories

on:
  push:
    branches: [main]
    paths: ['stories/**']
  workflow_dispatch:

jobs:
  sync:
    uses: franckbirba/dev-panel/.github/workflows/sync-stories.yml@main
    with:
      project-slug: <PROJECT-SLUG>
    secrets:
      SYNC_SSH_KEY: ${{ secrets.STORYBOOK_SYNC_SSH_KEY }}
      SYNC_HOST: ${{ secrets.VPS_HOST }}
```

Replace `<PROJECT-SLUG>` with the same slug used everywhere else in
`.devpanlrc.json` (lowercase, hyphen-safe, ≤ 30 chars).

3. Print a reminder for the human that the two repo secrets
   `STORYBOOK_SYNC_SSH_KEY` and `VPS_HOST` must be provisioned before
   the first push to main.

````

- [ ] **Step 3: Commit in the plugin repo**

```bash
git add commands/init.md
git commit -m "feat(init): scaffold stories/ and sync workflow"
```

- [ ] **Step 4: Push the plugin repo**

```bash
git push origin main
```
Expected: push succeeds.

---

## Task 15: End-to-end verification

**Files:**
- None — this task runs the full loop and confirms the system works.

- [ ] **Step 1: Push dev-panel's branch + merge to main (or open a PR and merge)**

The details depend on Franck's preferred merge flow. Push to a feature
branch and open a PR; after review, merge.

- [ ] **Step 2: Watch the `storybook-image` workflow succeed**

Run:
```bash
gh run list --workflow=storybook-image.yml --limit 1
gh run watch
```
Expected: conclusion=success. The image `ghcr.io/franckbirba/devpanl-storybook:latest` is now pushed.

- [ ] **Step 3: Run the VPS bootstrap script (once, as root on services VPS)**

On Franck's machine:
```bash
scp -i ~/.ssh/hetzner-vps infra/scripts/bootstrap/storybook-sync-user.sh root@77.42.46.87:/tmp/
ssh -i ~/.ssh/hetzner-vps root@77.42.46.87 'bash /tmp/storybook-sync-user.sh'
```
Expected: script prints `Done.` and the follow-up HELP text.

- [ ] **Step 4: Generate and install the devpanel-project SSH key**

On Franck's machine:
```bash
ssh-keygen -t ed25519 -f /tmp/storybook-sync-devpanel -N ''
cat /tmp/storybook-sync-devpanel      # copy private key → set as STORYBOOK_SYNC_SSH_KEY repo secret on dev-panel
cat /tmp/storybook-sync-devpanel.pub  # copy public key for next step
```

On the services VPS:
```bash
ssh -i ~/.ssh/hetzner-vps root@77.42.46.87
install -d -o storybook-sync -g storybook-sync /var/lib/devpanl/storybook-stories/devpanel
install -d -o storybook-sync -g storybook-sync /var/lib/devpanl/storybook-stories/shared
cat >> /var/lib/devpanl/storybook-stories/.ssh/authorized_keys <<EOF
command="/usr/share/doc/rsync/scripts/rrsync -wo /var/lib/devpanl/storybook-stories/devpanel",no-agent-forwarding,no-port-forwarding,no-pty,no-X11-forwarding <PASTE_PUBKEY_HERE>
EOF
```

Repeat for `shared` if using a separate key (recommended: one key per slug).

After setting secrets, delete the local copies:
```bash
shred -u /tmp/storybook-sync-devpanel /tmp/storybook-sync-devpanel.pub
```

- [ ] **Step 5: Trigger the `deploy.yml` workflow or wait for the next push**

After merge, watch:
```bash
gh run list --workflow=deploy.yml --limit 1
gh run watch
```
Expected: `deploy-core`, `sync-devpanel-stories`, `sync-shared-stories` all succeed.

- [ ] **Step 6: Confirm the storybook container is running on the VPS**

Run:
```bash
ssh -i ~/.ssh/hetzner-vps deploy@77.42.46.87 'docker ps --filter name=devpanel-storybook --format "{{.Names}}\t{{.Status}}"'
```
Expected: `devpanel-storybook   Up X seconds`.

- [ ] **Step 7: Open the browser catalogue**

Visit https://ui.devpanl.dev in a browser. Enter htpasswd credentials.

Expected: Storybook loads, sidebar shows `devpanel/` and `shared/`
sections with the five seeded stories (`Tokens` MDX, `Button`, `StatusChip`,
`MetricCard`, `SignalRow`), each rendering without errors on the dark
background.

- [ ] **Step 8: Sanity-check that a story edit round-trips**

In dev-panel:
```bash
echo "// touched $(date)" >> stories/devpanel/Button.stories.jsx
git add stories/devpanel/Button.stories.jsx
git commit -m "chore(stories): touch button story to verify sync"
git push
gh run watch   # wait for sync-devpanel-stories to finish
```

Reload https://ui.devpanl.dev in the browser. Expected: Storybook reloads
and the story is still present (comment is invisible in the rendered UI).

If everything passes: the feature is live.

- [ ] **Step 9: Revert the sanity commit**

```bash
git revert HEAD --no-edit
git push
```

---

## Self-review notes

Coverage check against the spec:

- Spec "New service in docker-compose.yml" → Task 5.
- Spec "The Storybook image" → Tasks 1–2.
- Spec "How stories land in the volume — approach A" → Tasks 7, 10.
- Spec "Authoring contract for agents" → Task 12 (plugin skill).
- Spec "Initial content" → Tasks 3–4.
- Spec "Plugin updates" → Tasks 12–14.
- Spec "Security" → Task 8 + Step 4 of Task 15 (per-project key).
- Spec "v1 scope" items 1–8 → Tasks 1 (scaffold), 2 (Dockerfile), 5 (compose), 6 (image CI), 7 (sync workflow), 8 (VPS user), 3+4 (seeds), 12–14 (plugin), 11 (CLAUDE.md).

No placeholder strings remain. Component-prop shapes in Task 4 are
best-guess and explicitly flagged to be verified against real source
before the story is committed — this is a necessary escape hatch
because actual prop schemas aren't knowable from this plan and changing
dashboard components to match invented props would be worse.
