# Zeno DevPanel Widget Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed the hosted `devpanl.dev/widget.js` on `zeno.epitools.bj` so staff can file bug/feature captures with screenshots from inside the Zeno app.

**Architecture:** Single `<script async>` tag in Zeno's `index.html` that pulls the already-shipped `/widget.js` bundle from DevPanel. Build-time env vars (`VITE_DEV_PANEL_URL`, `VITE_DEV_PANEL_API_KEY`) are passed through Zeno's existing `Dockerfile.prod` → Vite `%VITE_*%` HTML token replacement → baked into the final `dist/index.html`. DevPanel side requires a one-time CORS allow-list edit and a project-provisioning step for a dedicated Zeno API key.

**Tech Stack:** Vite 7 (HTML env interpolation), Docker multi-stage build, GitHub Actions CI, Express CORS allow-list on the DevPanel side.

**Spec:** `docs/superpowers/specs/2026-04-23-zeno-widget-integration-design.md`

---

## Prerequisites (gate before Task 1)

Two things must be true before any code-changing task below is worth running:

1. **`Dockerfile.prod` exists on the Zeno branch you intend to merge into.** Today it lives only on `refacto/dataset-dedup-and-patterns`. Zeno's `main`-branch CI references a file that isn't there. Resolve by merging `refacto/dataset-dedup-and-patterns` → `main`, cherry-picking `Dockerfile.prod` onto `main`, or doing the Zeno PR below on that feature branch. Confirm with Franck which path before starting.
2. **A Zeno DevPanel project has been provisioned** and its `dp_xxx` API key is available. Task 1 below covers provisioning. If Franck already created it out-of-band, skip Task 1 Step 1–3 and only add the GitHub secret (Step 4).

---

## File Structure

**Created:** none.

**Modified (Zeno repo):**
- `index.html` — add one `<script>` tag before `</body>`.
- `Dockerfile.prod` — two new `ARG` + `ENV` declarations. (File lives on `refacto/dataset-dedup-and-patterns`; see Prerequisites.)
- `.github/workflows/deploy.yml:86-93` — two new `--build-arg` flags on the `docker build -f Dockerfile.prod` command.

**GitHub (Zeno repo):**
- New secret `VITE_DEV_PANEL_API_KEY`.

**Ops (DevPanel services VPS `77.42.46.87`, no PR):**
- `.env` and `.env.production` — append `https://zeno.epitools.bj` to `ALLOWED_ORIGINS`.
- Bounce `devpanel` container.

**No changes in:** the DevPanel repo (code), Zeno's React tree, Zeno's nginx config.

---

## Task 1: Provision a Zeno project in DevPanel

**Goal:** Create the Zeno project row in DevPanel's master registry and get the `dp_xxx` API key.

**Files:** none in the repo. This task runs on the services VPS.

- [ ] **Step 1: SSH to the services VPS and check `ALLOWED_ORIGINS` while we're there**

We need this value in Task 5 anyway. Grab it now:

```bash
ssh deploy@77.42.46.87 'cd ~/dev-panel && grep ^ALLOWED_ORIGINS .env .env.production 2>/dev/null'
```

Expected: two lines (one from each file) showing the current value — either `ALLOWED_ORIGINS=*` or a comma-separated list. **Save this value** — Task 5 needs it.

If one of the files is missing the var, flag it. If `.env` and `.env.production` disagree, `.env` wins per `CLAUDE.md` — plan accordingly.

- [ ] **Step 2: Check whether a `zeno` project already exists**

```bash
ssh deploy@77.42.46.87 'docker compose -f ~/dev-panel/docker-compose.yml exec -T devpanel node bin/dev-panel.js admin list 2>&1 | head -20'
```

Expected: a table or list of projects. If a row named `zeno` (or similar) is already there with an API key, skip to Step 4 and use its key.

If the `admin list` subcommand doesn't exist (the CLI is `admin` without args = interactive), run this instead to inspect the DB directly:

```bash
ssh deploy@77.42.46.87 'docker compose -f ~/dev-panel/docker-compose.yml exec -T devpanel sqlite3 /data/projects.db "SELECT id, name, substr(api_key, 1, 8) || \"…\" FROM projects;"'
```

Expected: rows for each project. If a `zeno` row exists, grab its full `api_key` with:

```bash
ssh deploy@77.42.46.87 'docker compose -f ~/dev-panel/docker-compose.yml exec -T devpanel sqlite3 /data/projects.db "SELECT api_key FROM projects WHERE name=\"zeno\";"'
```

- [ ] **Step 3: Create the project if it doesn't exist**

```bash
ssh deploy@77.42.46.87 'docker compose -f ~/dev-panel/docker-compose.yml exec devpanel node bin/dev-panel.js admin'
```

This is interactive. Answer the prompts to create a new project named `zeno`. The command prints the generated `dp_xxx` API key at the end. **Copy it immediately** — most DevPanel CLIs only show the full key once.

If the CLI blocks on TTY allocation when run over SSH, add `-it`:

```bash
ssh -t deploy@77.42.46.87 'docker compose -f ~/dev-panel/docker-compose.yml exec devpanel node bin/dev-panel.js admin'
```

Expected output (roughly): `✓ Project "zeno" created. API key: dp_<32 hex chars>`.

- [ ] **Step 4: Add the API key as a GitHub secret in the Zeno repo**

```bash
cd /Users/franckbirba/DEV/Zeno
gh secret set VITE_DEV_PANEL_API_KEY --body "dp_<paste the key from Step 3>"
```

Expected: `✓ Set Actions secret VITE_DEV_PANEL_API_KEY for <owner>/<repo>`.

Verify:

```bash
gh secret list | grep VITE_DEV_PANEL_API_KEY
```

Expected: one row showing the secret name and "Updated" timestamp (the actual value is not printed — that's correct).

- [ ] **Step 5: No commit** — this task is ops only, nothing changed in the repo.

---

## Task 2: Add the widget `<script>` tag to Zeno's `index.html`

**Files:**
- Modify: `/Users/franckbirba/DEV/Zeno/index.html:31-34` (body section)

- [ ] **Step 1: Create a feature branch on Zeno**

Decide first: are you targeting `main` or `refacto/dataset-dedup-and-patterns`? Use the answer from Prerequisites gate.

```bash
cd /Users/franckbirba/DEV/Zeno
git fetch origin
git checkout -b feature/devpanel-widget-integration origin/<target-branch>
```

Replace `<target-branch>` with the decision from Prerequisites.

- [ ] **Step 2: Read the current `<body>` block**

Open `/Users/franckbirba/DEV/Zeno/index.html`. The current body is (lines 31–34):

```html
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
```

- [ ] **Step 3: Insert the widget `<script>` tag immediately after the main-module script**

Change the body to:

```html
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
    <!-- DevPanel widget — bug/feature reporter for staff. Loaded from
         devpanl.dev/widget.js. Config baked at build time via Vite's
         %VITE_*% HTML token replacement. In local dev the tokens stay
         literal; the widget bootstrap no-ops on the missing apiKey and
         the browser just logs a harmless 404 for the bundle URL. -->
    <script src="%VITE_DEV_PANEL_URL%/widget.js"
            data-api-key="%VITE_DEV_PANEL_API_KEY%"
            data-api-url="%VITE_DEV_PANEL_URL%"
            async></script>
  </body>
```

- [ ] **Step 4: Sanity-check the file locally**

```bash
cd /Users/franckbirba/DEV/Zeno
grep -n "VITE_DEV_PANEL" index.html
```

Expected: three matches on lines inside the new `<script>` tag (one `src`, one `data-api-key`, one `data-api-url`). No other lines matched.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
feat(devpanel): embed hosted devpanl.dev/widget.js on zeno.epitools.bj

One <script async> tag in index.html loads the DevPanel widget bundle
at runtime. Config (VITE_DEV_PANEL_URL, VITE_DEV_PANEL_API_KEY) is baked
into the HTML at build time via Vite's %VITE_*% template tokens — set
via Docker build-args in CI (next commit).

Local dev: placeholders stay literal, widget no-ops on missing apiKey,
one 404 in the browser console — acceptable trade-off vs plumbing a
conditional loader just for dev ergonomics.

Spec: dev-panel/docs/superpowers/specs/2026-04-23-zeno-widget-integration-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Plumb the two new build-args through `Dockerfile.prod`

**Files:**
- Modify: `/Users/franckbirba/DEV/Zeno/Dockerfile.prod` (on the branch where it exists)

- [ ] **Step 1: Read the current ARG/ENV block**

Open `Dockerfile.prod`. The relevant block today reads:

```dockerfile
# ARGs pour recevoir les variables Vite au moment du build
ARG VITE_API_URL
ARG VITE_DOCUSEAL_URL
ARG VITE_MOODLE_URL
ARG VITE_MOODLE_API_URL

# Variables d'environnement pour le build de production
ENV NODE_ENV=production
ENV VITE_APP_ENV=production
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_DOCUSEAL_URL=${VITE_DOCUSEAL_URL}
ENV VITE_MOODLE_URL=${VITE_MOODLE_URL}
ENV VITE_MOODLE_API_URL=${VITE_MOODLE_API_URL}

# Vérification des variables avant build
RUN echo "Build-time environment:" && \
    echo "VITE_API_URL=${VITE_API_URL}" && \
    echo "VITE_DOCUSEAL_URL=${VITE_DOCUSEAL_URL}" && \
    echo "VITE_MOODLE_URL=${VITE_MOODLE_URL}" && \
    echo "NODE_ENV=${NODE_ENV}"
```

- [ ] **Step 2: Append two `ARG` and two `ENV` lines**

Modify the block to:

```dockerfile
# ARGs pour recevoir les variables Vite au moment du build
ARG VITE_API_URL
ARG VITE_DOCUSEAL_URL
ARG VITE_MOODLE_URL
ARG VITE_MOODLE_API_URL
ARG VITE_DEV_PANEL_URL
ARG VITE_DEV_PANEL_API_KEY

# Variables d'environnement pour le build de production
ENV NODE_ENV=production
ENV VITE_APP_ENV=production
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_DOCUSEAL_URL=${VITE_DOCUSEAL_URL}
ENV VITE_MOODLE_URL=${VITE_MOODLE_URL}
ENV VITE_MOODLE_API_URL=${VITE_MOODLE_API_URL}
ENV VITE_DEV_PANEL_URL=${VITE_DEV_PANEL_URL}
ENV VITE_DEV_PANEL_API_KEY=${VITE_DEV_PANEL_API_KEY}

# Vérification des variables avant build
RUN echo "Build-time environment:" && \
    echo "VITE_API_URL=${VITE_API_URL}" && \
    echo "VITE_DOCUSEAL_URL=${VITE_DOCUSEAL_URL}" && \
    echo "VITE_MOODLE_URL=${VITE_MOODLE_URL}" && \
    echo "VITE_DEV_PANEL_URL=${VITE_DEV_PANEL_URL}" && \
    echo "NODE_ENV=${NODE_ENV}"
```

Note we added `VITE_DEV_PANEL_URL` to the echo line but **not** `VITE_DEV_PANEL_API_KEY` — the key should never hit build logs.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile.prod
git commit -m "$(cat <<'EOF'
feat(docker): accept VITE_DEV_PANEL_* build-args for widget embed

Two new ARG/ENV pairs forward the DevPanel widget config from CI into
Vite's env at build time, which in turn replaces the %VITE_*% tokens in
index.html. API key is deliberately omitted from the debug echo line —
only the URL is logged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add the two `--build-arg` flags to Zeno's CI

**Files:**
- Modify: `/Users/franckbirba/DEV/Zeno/.github/workflows/deploy.yml:86-93` (the "Build Docker images" step)

- [ ] **Step 1: Read the current `docker build` command**

The current block (lines 86-93) in `deploy.yml`:

```yaml
    - name: Build Docker images
      run: |
        docker build -f Dockerfile.prod --no-cache \
          --build-arg VITE_API_URL=https://zeno.epitools.bj/api \
          --build-arg VITE_DOCUSEAL_URL=https://zeno.epitools.bj/docuseal \
          --build-arg VITE_MOODLE_URL=https://zeno.epitools.bj/moodle \
          --build-arg VITE_MOODLE_API_URL=https://zeno.epitools.bj/moodle/webservice/rest/server.php \
          -t epitech-app:latest .
```

- [ ] **Step 2: Append two `--build-arg` flags before `-t`**

Modify to:

```yaml
    - name: Build Docker images
      run: |
        docker build -f Dockerfile.prod --no-cache \
          --build-arg VITE_API_URL=https://zeno.epitools.bj/api \
          --build-arg VITE_DOCUSEAL_URL=https://zeno.epitools.bj/docuseal \
          --build-arg VITE_MOODLE_URL=https://zeno.epitools.bj/moodle \
          --build-arg VITE_MOODLE_API_URL=https://zeno.epitools.bj/moodle/webservice/rest/server.php \
          --build-arg VITE_DEV_PANEL_URL=https://devpanl.dev \
          --build-arg VITE_DEV_PANEL_API_KEY=${{ secrets.VITE_DEV_PANEL_API_KEY }} \
          -t epitech-app:latest .
```

- [ ] **Step 3: Verify the YAML still parses**

```bash
cd /Users/franckbirba/DEV/Zeno
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))"
```

Expected: no output, exit code 0. If `python3 -c "import yaml"` fails with ModuleNotFoundError, fall back to:

```bash
cd /Users/franckbirba/DEV/Zeno
npx --yes js-yaml .github/workflows/deploy.yml > /dev/null && echo OK
```

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "$(cat <<'EOF'
ci(deploy): pass VITE_DEV_PANEL_* to the prod Docker build

Two extra --build-arg flags inject the widget URL and API key into the
Vite build, which substitutes them into index.html's %VITE_*% tokens.
The key comes from the VITE_DEV_PANEL_API_KEY GitHub secret (set out of
band).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Widen DevPanel's CORS allow-list on the services VPS

**Files:** none in the repo. This task runs on the services VPS.

**Safety note:** this is a narrow, forward-only change (adds one origin to an allow-list). Running it before the Zeno PR merges is safe — the new origin just doesn't have any traffic yet.

- [ ] **Step 1: Inspect the current values**

You already grabbed this in Task 1 Step 1. Re-read if needed:

```bash
ssh deploy@77.42.46.87 'cd ~/dev-panel && grep ^ALLOWED_ORIGINS .env .env.production 2>/dev/null'
```

Three possible states — each has a different fix:

- **(a) Both files contain `ALLOWED_ORIGINS=*`** → no change needed. Skip to Step 4.
- **(b) Both files contain the same comma-separated list** → append `,https://zeno.epitools.bj` to both.
- **(c) Files disagree** → `.env` wins per `CLAUDE.md`; fix both anyway to prevent future surprise.

- [ ] **Step 2: Append `https://zeno.epitools.bj` to both env files**

Pick the current list value from Step 1 output. For example, if the current line is:

```
ALLOWED_ORIGINS=https://devpanl.dev,https://edms.epitools.bj
```

Then run (replacing the CURRENT value exactly):

```bash
ssh deploy@77.42.46.87 'cd ~/dev-panel \
  && cp .env .env.bak.$(date +%s) \
  && cp .env.production .env.production.bak.$(date +%s) \
  && sed -i "s|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=https://devpanl.dev,https://edms.epitools.bj,https://zeno.epitools.bj|" .env .env.production'
```

Substitute the comma-separated value after `=` with whatever was actually in Step 1's output, plus `,https://zeno.epitools.bj` appended.

Verify:

```bash
ssh deploy@77.42.46.87 'cd ~/dev-panel && grep ^ALLOWED_ORIGINS .env .env.production'
```

Expected: both files now end with `,https://zeno.epitools.bj`.

- [ ] **Step 3: Restart the devpanel container with the new env**

Per `CLAUDE.md` "Deploy isolation": only refresh `devpanel`. Do not run `up -d` without `--no-deps` or you'll bounce Plane/Affine/etc.

```bash
ssh deploy@77.42.46.87 'cd ~/dev-panel && docker compose up -d --no-deps devpanel'
```

Expected: one line of `Recreating … devpanel … done` or `devpanel Started`.

- [ ] **Step 4: Verify CORS is picked up**

```bash
ssh deploy@77.42.46.87 'docker logs --tail 40 devpanel 2>&1 | grep -i cors'
```

Expected: a line like `✓ CORS: https://devpanl.dev,https://edms.epitools.bj,https://zeno.epitools.bj` (or whatever the updated list is). If you see `✓ CORS: * (all origins)`, that means state (a) from Step 1 — fine.

Also sanity-check the endpoint from outside, with a preflight as if from zeno.epitools.bj:

```bash
curl -sI -X OPTIONS https://devpanl.dev/api/captures \
  -H "Origin: https://zeno.epitools.bj" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type,x-api-key" | head -10
```

Expected: `HTTP/2 204` (or `200`) with `access-control-allow-origin: https://zeno.epitools.bj` in the headers. If instead you see `HTTP/2 500` with `Not allowed by CORS` or no `access-control-allow-origin` header, the restart didn't pick up the env — check for typos in the list and retry Step 3.

- [ ] **Step 5: No commit** — ops-only.

---

## Task 6: Open the Zeno PR and confirm CI passes

**Files:** none new. This task closes out the feature branch.

- [ ] **Step 1: Push the branch**

```bash
cd /Users/franckbirba/DEV/Zeno
git push -u origin feature/devpanel-widget-integration
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create \
  --title "Embed DevPanel widget on zeno.epitools.bj" \
  --body "$(cat <<'EOF'
## Summary
- Adds one `<script async>` tag in `index.html` pointing at `https://devpanl.dev/widget.js`.
- Plumbs `VITE_DEV_PANEL_URL` + `VITE_DEV_PANEL_API_KEY` through `Dockerfile.prod` and the CI `docker build` command.
- API key lives in the `VITE_DEV_PANEL_API_KEY` GitHub secret.

## Depends on (already done, out of band)
- DevPanel `/widget.js` endpoint live at `https://devpanl.dev/widget.js` (shipped 2026-04-22).
- DevPanel services VPS `ALLOWED_ORIGINS` now includes `https://zeno.epitools.bj`.

## Test plan
- [ ] CI builds successfully and produces `epitech-app:latest`.
- [ ] Deploy job pushes the image to the VPS and the container comes up.
- [ ] Visit https://zeno.epitools.bj/, log in as staff, confirm the FAB button appears bottom-right on any route.
- [ ] Open the widget, take a screenshot, file a test capture.
- [ ] Confirm the capture shows up in https://devpanl.dev/dashboard/captures under the `zeno` project.
- [ ] Browser console: no CORS errors, no 4xx/5xx against `devpanl.dev/api/*`.

Spec: `dev-panel/docs/superpowers/specs/2026-04-23-zeno-widget-integration-design.md`
EOF
)"
```

- [ ] **Step 3: Wait for CI to finish**

```bash
gh pr checks --watch
```

Expected: all green. The "Build Docker images" step should log (among others) `VITE_DEV_PANEL_URL=https://devpanl.dev` but should **not** log the API key value — confirm by inspecting the CI log if curious.

If `Build Docker images` fails with `required argument VITE_DEV_PANEL_API_KEY not set`, the GitHub secret from Task 1 Step 4 is missing — set it and re-run the workflow.

- [ ] **Step 4: Merge**

Confirm with Franck first, then:

```bash
gh pr merge --squash --delete-branch
```

The deploy job on main (or the target branch) will run automatically.

---

## Task 7: End-to-end verification in production

**Files:** none. Post-deploy manual verification.

- [ ] **Step 1: Confirm the new image is running on the Zeno VPS**

```bash
ssh <zeno-vps-user>@<zeno-vps-host> 'docker ps --filter name=epitech-app --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"'
```

If you don't know the Zeno VPS host, ask Franck or check `.github/workflows/deploy.yml` for the `VPS_HOST` secret references.

Expected: one `epitech-app` row with status `Up`.

- [ ] **Step 2: Curl the deployed index.html and look for the widget tag**

```bash
curl -s https://zeno.epitools.bj/app/index.html | grep -i devpanl
```

Wait — Zeno serves `/` as the Astro landing and `/app/` as the React SPA. The `<script>` we added is in the React SPA's `index.html`. Try:

```bash
curl -s https://zeno.epitools.bj/app/ | grep -i devpanl
```

Expected: one match showing the `<script>` tag with the tokens **replaced**, e.g.:

```html
<script src="https://devpanl.dev/widget.js" data-api-key="dp_…" data-api-url="https://devpanl.dev" async></script>
```

If the response still contains the literal `%VITE_DEV_PANEL_URL%`, the Vite build didn't receive the env vars — go back to Task 3 or Task 4 and check the ARG/ENV plumbing.

If `data-api-key=""` (empty), the GitHub secret was missing — check Task 1 Step 4 and rebuild.

- [ ] **Step 3: Browser-verify the FAB appears**

Open `https://zeno.epitools.bj/app/` in a real browser (use Playwright MCP or Chrome DevTools MCP per `CLAUDE.md` "feedback_browser_verify" memory). Log in as staff. Confirm:

- The DevPanel floating FAB button appears bottom-right on the page.
- DevTools → Network: `/widget.js` loads with status 200 from `devpanl.dev`.
- DevTools → Console: no red errors.

- [ ] **Step 4: File a test capture end-to-end**

Click the FAB, type a short bug report like "test capture from zeno — ignore", take a screenshot, submit. Confirm:

- The modal closes without error.
- Network tab shows `POST https://devpanl.dev/api/captures` → 200/201.
- `POST https://devpanl.dev/api/captures/<id>/messages` (screenshot upload) → 200/201.

- [ ] **Step 5: Confirm the capture landed in the DevPanel inbox**

Open `https://devpanl.dev/dashboard/captures`. Filter by the zeno project if the UI exposes a filter; otherwise look for the most recent capture. Expected: your test capture is there with the screenshot rendered inline in the thread.

- [ ] **Step 6: Clean up the test capture**

From the dashboard, drop/resolve the test capture so it doesn't pollute the real inbox. If a "drop" action isn't wired up yet, leave it — Franck can clear later.

---

## Self-Review Checklist

**Spec coverage:**
- §Design §1 (provision project) → Task 1.
- §Design §2 (embed `<script>` in `index.html`) → Task 2.
- §Design §3 (wire CI build args) → Task 4.
- §Design §4 (Dockerfile.prod ARG/ENV) → Task 3.
- §Design §5 (CORS allow-list on DevPanel) → Task 5.
- §Design §6 (no DevPanel repo code changes) → nothing to do, confirmed.
- §Rollout (CORS first, then Zeno PR) → Tasks 1+5 precede Tasks 2-6; Task 5 explicitly safe-to-run-first.
- §Testing (manual primary) → Task 7.
- §Non-goals (no per-route gating, no React changes, no local-dev) → respected; `index.html` edit is the only Zeno code touch.
- §Branch caveat (Dockerfile.prod only on refacto branch) → surfaced in Prerequisites section, referenced in Task 2 Step 1 and Task 3.

**Placeholder scan:** none — every code-changing step has complete code or complete command.

**Type consistency:**
- `VITE_DEV_PANEL_URL` / `VITE_DEV_PANEL_API_KEY` names match across `index.html` (Task 2), `Dockerfile.prod` (Task 3), and `deploy.yml` (Task 4). ✓
- GitHub secret name `VITE_DEV_PANEL_API_KEY` (Task 1 Step 4) matches the reference `${{ secrets.VITE_DEV_PANEL_API_KEY }}` in Task 4. ✓
- CORS allow-list change (Task 5) aligns with the widget's outbound origin `https://zeno.epitools.bj` (Task 4 build arg `VITE_API_URL=https://zeno.epitools.bj/api` confirms the hostname). ✓
- `admin` CLI reference in Task 1 matches `CLAUDE.md` "Key CLI commands" block (`node bin/dev-panel.js admin`). ✓

Ready to execute.
