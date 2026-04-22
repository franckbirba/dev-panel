# Storybook in the devpanl stack

**Date:** 2026-04-22
**Status:** Design — awaiting user review
**Owner:** Franck

## Why

The devpanl stack is the operating system of Franck's solo-with-agents studio. Agents (ephemeral `claude -p` workers dispatched by Shelly) build real apps — Zeno, EDMS, candidat, the dev-panel dashboard and widget. They produce **inconsistent UI** across projects because there is no shared, documented vocabulary they can look at. Each run reinvents a Button, spaces a Card differently, picks a color from the air.

Storybook is the fix: one place where every approved component, token and pattern lives, versioned per project, browsable by any agent before it writes UI code. It joins Plane/Penpot/Affine as persistent team infra in the stack.

## What we are building

**A single shared Storybook instance**, hosted at `ui.devpanl.dev`, that catalogues components for all studio projects. Stories live in each project's own repo and are synced into a shared volume by CI on every push. The sidebar is organized by project (`devpanel/`, `zeno/`, `edms/`, `candidat/`, `shared/`), and a top-level `shared/` section holds tokens + primitives that apply across projects.

This is **not** a shared npm package. There is no `@devpanl/ui`. Each project keeps its own components; Storybook just makes them visible and comparable in one place so agents can see what "good" looks like before building a new screen.

## Architecture

### New service in docker-compose.yml

```yaml
storybook:
  image: ghcr.io/franckbirba/devpanl-storybook:latest
  profiles: [core, all]
  networks: [web, internal]
  volumes:
    - storybook-stories:/stories:ro
  labels:
    - traefik.enable=true
    - traefik.http.routers.storybook.rule=Host(`ui.devpanl.dev`)
    - traefik.http.routers.storybook.entrypoints=websecure
    - traefik.http.routers.storybook.tls.certresolver=le
    - traefik.http.routers.storybook.middlewares=storybook-auth
    - traefik.http.middlewares.storybook-auth.basicauth.usersfile=/etc/traefik/.htpasswd
```

Named volume `storybook-stories` added to the `volumes:` block. Placed under `[core, all]` so it comes up with the rest of the persistent infra.

### The Storybook image

New folder `infra/storybook/` in the dev-panel repo:

```
infra/storybook/
├── Dockerfile                 # node:20-slim → storybook dev server on :6006
├── .storybook/
│   ├── main.js                # stories: ['/stories/**/*.stories.@(js|jsx|mdx)']
│   ├── preview.js             # global decorators, theme switcher placeholder
│   └── manager.js             # sidebar: group by top-level folder
├── package.json               # storybook@8, @storybook/react-vite, react 19
└── index.html
```

Storybook runs in dev mode inside the container (not a static build) so new stories appearing in the volume are picked up on browser reload — no rebuild required when a project pushes new stories.

The container reads `/stories/` read-only. Writes only happen via the sync mechanism (below).

### How stories land in the volume — approach A

Each project keeps its stories in its own repo, under `stories/` at the root:

```
zeno-repo/
├── src/...
└── stories/
    ├── LoginScreen.stories.jsx
    ├── Dashboard.stories.jsx
    └── components/
        └── Button.stories.jsx
```

A GitHub Action on every push to `main` does an `rsync` of that folder into the shared volume on the services VPS, into a project-scoped subdirectory:

```
volume: /stories/
  ├── devpanel/      ← from dev-panel repo's stories/
  ├── zeno/          ← from zeno repo's stories/
  ├── edms/
  ├── candidat/
  └── shared/        ← from dev-panel repo's stories-shared/ (tokens + cross-project primitives)
```

Sync mechanism, concretely: a reusable workflow hosted in dev-panel, `/.github/workflows/sync-stories.yml`, that other repos call via `workflow_call`. It does:

```bash
rsync -av --delete stories/ \
  deploy@services.devpanl.dev:/var/lib/devpanl/storybook-stories/<project-slug>/
```

Projects opt in by adding a ~10-line caller workflow. The reusable workflow owns the SSH key (GitHub secret on the caller repo), the target path pattern, and the `--delete` semantics so removed stories actually disappear from the catalog.

For dev-panel itself, a step in its own deploy workflow syncs `stories/` → `/stories/devpanel/` and `stories-shared/` → `/stories/shared/`.

### Authoring contract for agents

Stories live at `stories/<path>.stories.jsx` in the consuming project's repo. They import components by **relative path from that repo only** — no cross-project imports. Agents are told:

> Your story imports your component. Another project's Storybook section shows you patterns you can copy, but you copy the *code*, not the *import*. Storybook is a catalogue, not a module graph.

This keeps each project self-contained and the sync rsync-simple.

### Initial content

Seeding dev-panel's slot on day one, so the instance isn't empty:

- `stories/devpanel/tokens.mdx` — the color/spacing/radius/font tables from `src/dashboard/theme.js`, as an MDX doc page.
- `stories/devpanel/Button.stories.jsx`, `StatusChip`, `MetricCard`, `SignalRow` — four real dashboard components with every variant/state they already support.
- `stories-shared/tokens.mdx` — a copy of the tokens table, framed as the shared vocabulary (identical content for now, diverges later if other projects need it).

Five files. That's the seed.

## Plugin updates — `devpanl-claude-plugin`

The plugin is how agents in other repos learn the devpanl conventions. Three changes:

1. **New skill `storybook-authoring.md`** — one-page rulebook: where stories live in a repo (`stories/`), naming convention, import rules, how they end up at `ui.devpanl.dev`, and "check the catalogue before inventing a new primitive".
2. **Update `skills/devpanl-readiness.md`** — add a readiness check: does this project have a `stories/` folder and a `.github/workflows/sync-stories.yml` caller? If not, flag it.
3. **Update `commands/init.md`** — `/devpanl:init` now creates `stories/.keep` and adds the caller workflow file.

No new command needed. The catalogue lives at `ui.devpanl.dev` behind the same htpasswd as the other infra; agents with access to the stack already have access.

## Data flow

```
project repo push to main
  → GitHub Actions
    → rsync stories/ over SSH
      → /var/lib/devpanl/storybook-stories/<project>/ (services VPS)
        → mounted read-only into storybook container at /stories/<project>/
          → Storybook dev server picks up new files
            → https://ui.devpanl.dev shows them in the <project> sidebar section
```

No Redis, no API, no DB. Files in, files out. The only auth is the SSH key for rsync and the Traefik htpasswd for the browser.

## Security

- **Rsync target** — a dedicated system user on the services VPS (`storybook-sync`), no shell, rsync-only via `authorized_keys` `command=` restriction, chrooted to `/var/lib/devpanl/storybook-stories/<project>/`. Each project repo holds its own SSH key pointing at its own subdir; a leak in Zeno's key can't overwrite dev-panel's stories.
- **Read-only mount** — the storybook container cannot write to `/stories`, so a compromised Storybook process cannot tamper with what projects ship.
- **Browser auth** — same htpasswd already guarding affine/bull-board. No public exposure.

## Failure modes

- **Broken story crashes a project section** — Storybook isolates story errors per module; a bad `Button.stories.jsx` in zeno shows an error panel for that story, the rest of the catalogue keeps working.
- **Sync fails** — CI job reports red, old stories remain in the volume (rsync `--delete` only runs on success). No silent drift.
- **Volume fills** — stories are text files, volume is tiny (< 100MB projected for all four projects). Not a concern at this scale; monitor via uptime-kuma disk check already in place.
- **Storybook restart loses nothing** — all state is in the volume, no DB.

## Out of scope for v1

- Shared npm package of primitives (`@devpanl/ui` idea). Maybe never — agents copying patterns works fine if the catalogue is honest.
- Visual regression tests (Chromatic, Percy). Add only if agents start breaking things.
- Penpot → Storybook sync. Separate project.
- Per-project auth on the browser side. One htpasswd is enough while it's just Franck + his agents.
- A dashboard view inside dev-panel showing story counts / last sync per project. Nice, not needed.
- Public/marketing showcase. This is internal tooling.

## v1 scope — what we build

1. `infra/storybook/` folder with Dockerfile, `.storybook/` config, `package.json`. Local `make storybook-dev` target that runs it against `./stories/`.
2. `storybook` service added to `docker-compose.yml` under `[core, all]` with Traefik route `ui.devpanl.dev` and the shared volume.
3. `.github/workflows/storybook-image.yml` — builds and pushes `ghcr.io/franckbirba/devpanl-storybook:latest` on changes under `infra/storybook/**`.
4. `.github/workflows/sync-stories.yml` — reusable workflow (`workflow_call`) that rsyncs a caller repo's `stories/` into the target volume subdir.
5. Services VPS prep: create `storybook-sync` system user, install its authorized_keys entry with a rsync-restricted `command=`, create `/var/lib/devpanl/storybook-stories/` with correct ownership, mount it as the `storybook-stories` docker volume.
6. Seed stories: `stories/devpanel/tokens.mdx`, `Button.stories.jsx`, `StatusChip.stories.jsx`, `MetricCard.stories.jsx`, `SignalRow.stories.jsx`, plus `stories-shared/tokens.mdx`.
7. In `devpanl-claude-plugin` repo: add `skills/storybook-authoring.md`, update `skills/devpanl-readiness.md`, update `commands/init.md` to scaffold `stories/.keep` + caller workflow.
8. CLAUDE.md update in dev-panel: short section under the stack list pointing agents at `ui.devpanl.dev` and the authoring skill.

Each step is self-contained; 5 can run in parallel with 1-4.

## Open questions — explicitly resolved

- **"Why not @devpanl/ui shared package?"** → Rejected. Franck said agents should see a documented vocabulary; copying approved patterns from a live catalogue achieves that without a versioning / publishing treadmill.
- **"Why approach A (git sync) over B (API upload)?"** → Chosen by Franck. Keeps stories under version control in the project that owns them. No new API surface on devpanel.
- **"Storybook dev mode or static build in the container?"** → Dev mode. New stories appear on reload, no image rebuild needed when a project pushes.
