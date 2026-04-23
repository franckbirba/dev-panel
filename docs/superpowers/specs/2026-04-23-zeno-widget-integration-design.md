# Zeno DevPanel widget integration — prod

**Status:** approved
**Author:** Claude (with Franck)
**Date:** 2026-04-23
**Depends on:** `docs/superpowers/specs/2026-04-22-standalone-widget-design.md` (the `/widget.js` bundle must already be live on `devpanl.dev`)

## Problem

Zeno (`zeno.epitools.bj`) is the third production React SPA in the studio (after the DevPanel dashboard itself and EDMS) and the second external site that should carry the bug/feature reporting widget. Staff using Zeno today have no in-app way to file captures — they ping Franck on Telegram or open the DevPanel dashboard manually. EDMS already got the `/widget.js` embed in the `2026-04-22-standalone-widget-design` rollout; Zeno is the obvious next follow-up (already mentioned as a non-scope item at the bottom of that spec).

## Goal

Ship the hosted `devpanl.dev/widget.js` embed on `zeno.epitools.bj` so any authenticated staff member can file a bug/feature/capture with screenshot from inside the app. Captures land in a dedicated "zeno" project in the DevPanel inbox (separate from dev-panel's own + EDMS's captures).

## Non-goals

- **No per-route gating** (staff vs students). The widget renders for every visitor of `zeno.epitools.bj`. Same decision as EDMS: staff-only surface in practice, so not worth the branching cost.
- **No React-side integration.** The embed is a plain `<script>` in `index.html`. Zeno's React tree is untouched.
- **No local-dev embedding.** `npm run dev` doesn't load the widget. Prod-only.
- **No feature trimming.** Full React DevPanel with screenshot, annotations, inspect overlay, region select, session recording — whatever the hosted bundle ships.
- **Not fixing Zeno's branch divergence.** `Dockerfile.prod` currently lives only on the `refacto/dataset-dedup-and-patterns` branch, not on `main` — the main-branch CI `docker build -f Dockerfile.prod` therefore has nothing to build. That's a separate mess to sort before this feature can actually deploy from `main`. Flagged below but not solved here.

## Design

### 1. Provision the Zeno project in DevPanel

One-time action before any code lands. Create a new project in the master `projects.db` registry on the services VPS. Two viable paths:

- **CLI on the VPS** (authoritative):
  ```bash
  ssh deploy@77.42.46.87 'cd ~/dev-panel && docker compose exec devpanel node bin/dev-panel.js admin'
  ```
  The `admin` command is listed as hidden in `CLAUDE.md`'s CLI section. It prompts for project creation and prints a fresh `dp_xxx` API key.
- **Via the devpanel MCP tool** if a `create_project` / `admin_create_project` is exposed — skip the SSH hop entirely from inside Shelly / Claude Code.

The returned API key becomes a GitHub repo secret on the **Zeno** repo, named `VITE_DEV_PANEL_API_KEY`. It is *not* committed anywhere.

Storage side-effect on the VPS: a new `storage/<new-project-uuid>/tickets.db` and `storage/<new-project-uuid>/captures.db` get created on first capture. Docker's named volume covers this; no manual dir creation.

### 2. Embed `<script>` in Zeno's `index.html`

Single edit to `/Users/franckbirba/DEV/Zeno/index.html`. Add one line before `</body>`:

```html
<!-- DevPanel widget — bug/feature reporter. Config baked at build time
     via Vite's %VITE_*% HTML token replacement; when the vars aren't set
     (local dev), the <script> tag still renders but the widget bootstrap
     no-ops because data-api-key is the literal string "%VITE_DEV_PANEL_API_KEY%"
     which fails the apiKey check. Harmless 404 in dev console — fine. -->
<script src="%VITE_DEV_PANEL_URL%/widget.js"
        data-api-key="%VITE_DEV_PANEL_API_KEY%"
        data-api-url="%VITE_DEV_PANEL_URL%"
        async></script>
```

Vite replaces `%VITE_*%` placeholders in `index.html` at build time — standard Vite behavior, already used by any app that templates its `<title>` or favicon from env. At build time on CI the vars resolve; at `npm run dev` they don't, so the literal `%…%` string stays. The widget's bootstrap reads `data-api-key` off the script tag; if that value is the literal placeholder (starts with `%`), the bootstrap's missing-key branch fires and does nothing. The browser still tries to fetch `%VITE_DEV_PANEL_URL%/widget.js` and gets a 404 — one red line in the console, no runtime impact. YAGNI: we accept the console noise rather than add a guard plugin.

### 3. Wire build args in Zeno's CI

Modify `.github/workflows/deploy.yml`, the "Build Docker images" step. Current block (line 86–98):

```yaml
docker build -f Dockerfile.prod --no-cache \
  --build-arg VITE_API_URL=https://zeno.epitools.bj/api \
  --build-arg VITE_DOCUSEAL_URL=https://zeno.epitools.bj/docuseal \
  --build-arg VITE_MOODLE_URL=https://zeno.epitools.bj/moodle \
  --build-arg VITE_MOODLE_API_URL=https://zeno.epitools.bj/moodle/webservice/rest/server.php \
  -t epitech-app:latest .
```

Add two build args:

```yaml
docker build -f Dockerfile.prod --no-cache \
  --build-arg VITE_API_URL=https://zeno.epitools.bj/api \
  --build-arg VITE_DOCUSEAL_URL=https://zeno.epitools.bj/docuseal \
  --build-arg VITE_MOODLE_URL=https://zeno.epitools.bj/moodle \
  --build-arg VITE_MOODLE_API_URL=https://zeno.epitools.bj/moodle/webservice/rest/server.php \
  --build-arg VITE_DEV_PANEL_URL=https://devpanl.dev \
  --build-arg VITE_DEV_PANEL_API_KEY=${{ secrets.VITE_DEV_PANEL_API_KEY }} \
  -t epitech-app:latest .
```

### 4. Declare the ARGs in `Dockerfile.prod`

`Dockerfile.prod` needs matching `ARG` + `ENV` lines so the values reach `npm run build`. Current block (on `refacto/dataset-dedup-and-patterns` branch):

```dockerfile
ARG VITE_API_URL
ARG VITE_DOCUSEAL_URL
ARG VITE_MOODLE_URL
ARG VITE_MOODLE_API_URL
…
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_DOCUSEAL_URL=${VITE_DOCUSEAL_URL}
ENV VITE_MOODLE_URL=${VITE_MOODLE_URL}
ENV VITE_MOODLE_API_URL=${VITE_MOODLE_API_URL}
```

Append two lines to each group:

```dockerfile
ARG VITE_DEV_PANEL_URL
ARG VITE_DEV_PANEL_API_KEY
…
ENV VITE_DEV_PANEL_URL=${VITE_DEV_PANEL_URL}
ENV VITE_DEV_PANEL_API_KEY=${VITE_DEV_PANEL_API_KEY}
```

**Branch caveat (scope-flag, not solved here):** `Dockerfile.prod` is **not on `main`**; it only exists on `refacto/dataset-dedup-and-patterns`. The main-branch CI references a file that isn't there, which means the current `main` CI can't be producing working images at all. Before this Zeno widget work can ship to prod, that branch situation needs resolving — either merge `refacto/dataset-dedup-and-patterns` to `main`, or cherry-pick `Dockerfile.prod` onto `main`. This spec assumes the Zeno PR lands on whichever branch actually deploys; the implementation plan will call it out as a prerequisite gate rather than pretending we can ship without it.

### 5. Allow `zeno.epitools.bj` as a CORS origin on DevPanel

The widget's JS runs on `zeno.epitools.bj` and POSTs to `https://devpanl.dev/api/captures`. DevPanel's `src/server/index.js` gates CORS via the `ALLOWED_ORIGINS` env var (comma-separated allow-list, or `*` for open). On the services VPS, add `https://zeno.epitools.bj` to `ALLOWED_ORIGINS` in `.env.production` and restart the `devpanel` container:

```bash
ssh deploy@77.42.46.87 'cd ~/dev-panel \
  && sed -i.bak "s|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=<previous list>,https://zeno.epitools.bj|" .env.production \
  && docker compose up -d --no-deps devpanel'
```

(Replace `<previous list>` with whatever's already there.) If `ALLOWED_ORIGINS=*`, no change needed. Verify by reading the container startup log for `✓ CORS: …`.

Because `.env` shadows `.env.production` in Docker Compose (per `CLAUDE.md` "Plane caveats"), also update `.env` on the VPS — or symlink `.env → .env.production` once and for all.

### 6. No changes to DevPanel repo code

Everything DevPanel needs is already in place from the `2026-04-22-standalone-widget` work:
- `/widget.js` route with `Cross-Origin-Resource-Policy: cross-origin`
- Bundle at `dist/widget.js`, served with 5-min cache
- Per-project API-key auth on `POST /api/captures`

The only DevPanel-side action is the `.env` allow-list edit from step 5, which is ops, not code.

### Error handling

- **Bad / missing API key at runtime:** DevPanel rejects the POST with 401. The widget already surfaces that in its own error UI (same path as EDMS).
- **CORS misconfig:** widget POST fails preflight, captures don't land. Visible immediately in browser DevTools Network tab; fix is step 5.
- **Widget bundle 404 (e.g., dev-panel container restarting):** browser console errors, FAB doesn't appear. Zeno page works normally — the `<script async>` doesn't block render.
- **Zeno's `VITE_DEV_PANEL_API_KEY` secret missing from CI:** the build arg resolves to empty string → `data-api-key=""` → widget bootstrap logs "missing apiKey" and no-ops. No crash, no mount.

### Testing

1. **Manual (primary):** after deploy, visit `https://zeno.epitools.bj/` logged in as staff. FAB button appears bottom-right. Click → bug report modal opens. Take a screenshot, submit. Verify it appears in `https://devpanl.dev/dashboard/captures` filtered by the new "zeno" project.
2. **Browser console check:** no CORS errors, no 4xx/5xx to `devpanl.dev/api/captures`, no errors from the widget bundle load.
3. **No unit tests.** Everything is a config change (CI args, `index.html`, `.env`). No logic to assert.

### Rollout

Two PRs in two repos:

1. **Zeno PR (depends on branch strategy above):**
   - `index.html`: add the `<script>` tag.
   - `Dockerfile.prod`: add ARG + ENV for the two new vars.
   - `.github/workflows/deploy.yml`: add the two `--build-arg` lines.
   - Create `VITE_DEV_PANEL_API_KEY` GitHub secret before merging.
   - Merge → CI builds → new image deploys to Zeno VPS.

2. **Dev-panel / services VPS ops (no PR):**
   - Add `https://zeno.epitools.bj` to `ALLOWED_ORIGINS` on both `.env` and `.env.production`.
   - Bounce `devpanel` container: `docker compose up -d --no-deps devpanel`.

Order: do the CORS edit first (safe — just widens the allow-list), then merge the Zeno PR. If rollout order slips, the worst case is a few minutes of "CORS preflight failed" errors in a staff member's browser, no data loss.

## Notes

- **Why not gate the widget to `/admin` routes only?** Zeno's route tree isn't cleanly split into "staff" vs "student" paths, and the widget is server-rendered by a `<script>` tag, not a React component, so conditional mounting would mean an extra React component + a `useEffect` that injects the tag. Straight embed in `index.html` is one line and matches the EDMS pattern. Revisit if a student ever opens the widget and creates a junk capture — at which point we just add auth-checking inside DevPanel's capture endpoint, which is a problem the API layer should solve anyway.
- **Future cleanup:** once `candidat.epitools.bj` and similar sites also embed the widget, consider a shared `devpanl-embed.sh` helper or a generic `sync-devpanel-widget` workflow to keep the `<script>` snippet + CORS origin in sync across repos. Not worth doing for 2 sites.
- **Bundle size impact on Zeno's page load:** none measurably — `<script async>` doesn't block render, and the bundle is only ~300–500 kB gzipped (per the 2026-04-22 spec's size estimate). Cached for 5 min after first load.
