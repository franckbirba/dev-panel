# Standalone Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the React `DevPanel` widget as a single-file IIFE at `dist/widget.js`, served by Express at `https://devpanl.dev/widget.js`, so any staff site can embed it with a single `<script>` tag that auto-mounts on page load.

**Architecture:** Second Vite config (`vite.widget.config.js`) builds from a new entry `src/react/widget-entry.jsx` that reads `data-api-key` / `data-api-url` off its `<script>` tag, creates a root div on `document.body`, and mounts the existing `DevPanel` component. React + ReactDOM + html2canvas + all DevPanel surface code are bundled into one IIFE. CSS is inlined into the JS via a Rollup post-build hook so consumers need no separate `<link>` tag. Express serves the file at `/widget.js` with `Cache-Control: max-age=300`. CI rsync now also uploads `dist/widget.js` to the VPS volume. EDMS `portal-router.ts` switches its 115-line vanilla widget to a one-line `<script>` tag.

**Tech Stack:** Vite 8 (IIFE build mode), React 19, html2canvas (already a dep), Express static serving, rollup `generateBundle` hook for CSS inlining.

**Spec:** `docs/superpowers/specs/2026-04-22-standalone-widget-design.md`

---

## File Structure

**Created:**
- `src/react/widget-entry.jsx` — IIFE bootstrap. Reads config from `document.currentScript.dataset`, mounts `<DevPanel>` once DOM is ready. ~35 lines.
- `vite.widget.config.js` — Vite config for the widget build. IIFE format, CSS inlined, dynamic imports rolled in, outputs `dist/widget.js`.
- `tests/server/widget-route.test.js` — integration test that `GET /widget.js` returns the bundle with the right cache headers.

**Modified:**
- `src/server/index.js` — new `/widget.js` static route near the existing dashboard mount. ~10 lines added.
- `package.json` — split `build` into `build:dashboard` + `build:widget`, have `build` run both. Update `files` array to include `dist/widget.js` (in case anyone npm-installs the package).
- `.github/workflows/deploy.yml` — extend the scp `source` glob to include `dist/widget.js`.

**In EDMS (separate repo, separate PR):**
- `packages/server/src/portal-router.ts` — replace the 115-line `renderDevPanelWidget()` body with a one-line `<script>` tag generator.

**No changes needed in:** Dockerfile (`dist/` is volume-mounted), docker-compose.yml (mount already covers `dist/widget.js`), existing `src/react/*` components (entry file wraps them without touching them).

---

## Task 1: Widget entry file

**Files:**
- Create: `src/react/widget-entry.jsx`

- [ ] **Step 1: Create the entry file**

```jsx
// src/react/widget-entry.jsx
//
// IIFE entry for the standalone /widget.js bundle. This file exists only
// for the vite.widget.config.js build target — the React app (dashboard)
// and the npm `./react` export both use DevPanel.jsx directly.
//
// Bootstrap: read data-api-key / data-api-url from our own <script> tag,
// inject a root div, mount DevPanel once the DOM is ready. Idempotent.

import { createRoot } from 'react-dom/client';
import { DevPanel } from './DevPanel.jsx';

const ROOT_ID = 'devpanel-widget-root';

function mount() {
  if (document.getElementById(ROOT_ID)) return; // already mounted

  // document.currentScript is null in module contexts but fine here (IIFE).
  // Fall back to querying for the last loaded script with a data-api-key.
  const script = document.currentScript
    ?? document.querySelector('script[src*="/widget.js"][data-api-key]');
  const apiKey = script?.dataset?.apiKey;
  const apiUrl = script?.dataset?.apiUrl;

  if (!apiKey) {
    console.warn('[DevPanel widget] data-api-key missing on <script>, not mounting.');
    return;
  }

  const root = document.createElement('div');
  root.id = ROOT_ID;
  document.body.appendChild(root);
  createRoot(root).render(<DevPanel apiKey={apiKey} apiUrl={apiUrl} />);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/react/widget-entry.jsx
git commit -m "$(cat <<'EOF'
feat(react-widget): add IIFE entry file for standalone /widget.js bundle

Bootstrap reads data-api-key + data-api-url from its own <script> tag,
injects a root div, mounts the existing DevPanel component. Used only by
the new vite.widget.config.js build target — DevPanel.jsx itself is
unchanged and keeps being consumed by the React dashboard and the npm
export.

Spec: docs/superpowers/specs/2026-04-22-standalone-widget-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Vite widget config

**Files:**
- Create: `vite.widget.config.js`

- [ ] **Step 1: Create the widget Vite config**

```js
// vite.widget.config.js
//
// Build target #2: a single-file IIFE bundle for the public /widget.js
// endpoint. Distinct from vite.config.js which builds the dashboard SPA.
// Run via `npm run build:widget`.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Rollup plugin: after build, read the emitted CSS asset (if any) and
// inline it into the JS chunk as a runtime style tag injection. Ensures
// consumer sites don't need a separate <link> tag.
function inlineCssPlugin() {
  return {
    name: 'inline-css-into-iife',
    generateBundle(_opts, bundle) {
      const cssFile = Object.keys(bundle).find(k => k.endsWith('.css'));
      const jsFile = Object.keys(bundle).find(k => k.endsWith('.js'));
      if (!cssFile || !jsFile) return;
      const css = bundle[cssFile].source ?? '';
      delete bundle[cssFile]; // drop the standalone .css output
      const prefix = `(function(){var s=document.createElement('style');s.setAttribute('data-devpanel-widget','');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);})();`;
      bundle[jsFile].code = prefix + bundle[jsFile].code;
    }
  };
}

export default defineConfig({
  plugins: [react(), inlineCssPlugin()],
  // Widget imports html2canvas dynamically; we want it rolled into the
  // main chunk rather than a separate lazy-loaded JS file.
  build: {
    outDir: 'dist',
    emptyOutDir: false, // don't wipe dist/dashboard
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(__dirname, 'src/react/widget-entry.jsx'),
      name: 'DevPanelWidget',
      formats: ['iife'],
      fileName: () => 'widget.js'
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
    }
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add vite.widget.config.js
git commit -m "$(cat <<'EOF'
feat(build): vite.widget.config.js for the standalone IIFE widget

IIFE format, React + ReactDOM + html2canvas bundled, dynamic imports
inlined (no secondary chunks), CSS inlined into the JS via a tiny
generateBundle rollup hook. Output: dist/widget.js.

emptyOutDir: false so the widget build doesn't wipe dist/dashboard/
when they run in sequence.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire up `npm run build`

**Files:**
- Modify: `package.json:15-20` (scripts)

- [ ] **Step 1: Replace the `scripts` block**

Find the current scripts:

```json
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "vite build",
    "dev:dashboard": "vite --config vite.config.js"
  },
```

Replace with:

```json
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build:dashboard": "vite build",
    "build:widget": "vite build --config vite.widget.config.js",
    "build": "npm run build:dashboard && npm run build:widget",
    "dev:dashboard": "vite --config vite.config.js"
  },
```

- [ ] **Step 2: Run the full build and confirm both outputs land**

Run: `npm run build`
Expected:
- No errors.
- `dist/dashboard/index.html` exists (dashboard build).
- `dist/widget.js` exists (widget build).
- `dist/widget.js` is > 100 kB (it bundles React + ReactDOM + DevPanel surface).

Verify with:
```bash
ls -lh dist/widget.js dist/dashboard/index.html
```

- [ ] **Step 3: Sanity-check the widget loads and mounts in a browser**

Quick manual check — serve it and open in a browser:

```bash
# In one terminal:
npx http-server dist -p 8888 --cors

# In a second terminal, create a tiny test page:
cat > /tmp/widget-smoke.html <<'HTML'
<!DOCTYPE html><html><body>
<h1>widget smoke</h1>
<script src="http://localhost:8888/widget.js" data-api-key="dp_test" data-api-url="http://localhost:3030" async></script>
</body></html>
HTML

# Open it:
open /tmp/widget-smoke.html
```

Expected: no console errors except "`DevPanel: apiKey is required…`" if the key is rejected by the real dev API. The floating FAB button appears on the page. Clicking it opens the DevPanel modal (bug report form).

If the FAB doesn't appear, check the browser console — common failures: (a) CORS issue loading the script (use `--cors` on http-server), (b) CSS not injected (check `<style data-devpanel-widget>` in the DOM).

Kill the http-server when done.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
chore(build): split `npm run build` into dashboard + widget targets

`npm run build` now produces both dist/dashboard (the SPA) and
dist/widget.js (the standalone embed). Individual targets available as
build:dashboard and build:widget.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Failing integration test for the Express route

**Files:**
- Create: `tests/server/widget-route.test.js`

- [ ] **Step 1: Create the failing test**

```javascript
// tests/server/widget-route.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';

// This test exercises the /widget.js Express route. The route should
// (a) respond 200, (b) set Cache-Control: public, max-age=300, (c) send
// the contents of dist/widget.js. We stub a fake dist/widget.js in a
// temp location and point the test server at it via the real app —
// since the app reads dist/ relative to src/server/, we just ensure a
// dist/widget.js exists at the expected path for this test run.

describe('GET /widget.js', () => {
  let app;
  beforeEach(async () => {
    // The widget route reads from ../../dist/widget.js relative to
    // src/server/index.js. Make sure that file exists for this test.
    const distDir = join(process.cwd(), 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'widget.js'), '/* test widget bundle */\n');

    const storage = mkdtempSync(join(tmpdir(), 'devpanel-widget-'));
    const { createServer } = await import('../../src/server/index.js');
    ({ app } = createServer(storage));
  });

  it('returns the widget bundle', async () => {
    const r = await request(app).get('/widget.js');
    expect(r.status).toBe(200);
    expect(r.text).toContain('test widget bundle');
  });

  it('sets a 5-minute public Cache-Control', async () => {
    const r = await request(app).get('/widget.js');
    expect(r.headers['cache-control']).toContain('public');
    expect(r.headers['cache-control']).toContain('max-age=300');
  });

  it('serves with Content-Type: application/javascript', async () => {
    const r = await request(app).get('/widget.js');
    expect(r.headers['content-type']).toMatch(/javascript/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/server/widget-route.test.js`
Expected: all three tests FAIL with 404 responses (route doesn't exist yet).

---

## Task 5: Implement the `/widget.js` Express route

**Files:**
- Modify: `src/server/index.js:62-75` (around the dashboard static mount)

- [ ] **Step 1: Locate the dashboard static mount**

Open `src/server/index.js`. Find the block that starts:

```javascript
  // Dashboard SPA
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dashboardDistDir = path.join(__dirname, '..', '..', 'dist', 'dashboard');
```

- [ ] **Step 2: Add the widget route immediately after the dashboardDistDir declaration**

Insert before `// Serve built dashboard assets`:

```javascript
  // Standalone DevPanel widget bundle — served at /widget.js so any staff
  // site can embed with a single <script> tag. 5-minute cache so bumps
  // propagate quickly without explicit versioning. Spec:
  // docs/superpowers/specs/2026-04-22-standalone-widget-design.md
  const widgetPath = path.join(__dirname, '..', '..', 'dist', 'widget.js');
  app.get('/widget.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.sendFile(widgetPath, (err) => {
      if (err && !res.headersSent) res.status(404).send('widget not built');
    });
  });
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/server/widget-route.test.js`
Expected: all three tests PASS.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run --exclude tests/worker/bootstrap-project.test.js`
Expected: every test passes.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.js tests/server/widget-route.test.js
git commit -m "$(cat <<'EOF'
feat(server): serve dist/widget.js at /widget.js with 5min cache

Public, staff-targeted route. Any site embeds with:

  <script src="https://devpanl.dev/widget.js"
          data-api-key="dp_xxx"
          data-api-url="https://devpanl.dev"
          async></script>

Cache-Control: public, max-age=300 — widget bumps propagate in 5 min
without needing explicit version bumps in consumer sites.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Extend CI rsync to include `dist/widget.js`

**Files:**
- Modify: `.github/workflows/deploy.yml:44`

- [ ] **Step 1: Update the scp source glob**

Find:

```yaml
          source: "infra/*,docker-compose.yml,Makefile,dist/dashboard/**"
```

Replace with:

```yaml
          source: "infra/*,docker-compose.yml,Makefile,dist/dashboard/**,dist/widget.js"
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "$(cat <<'EOF'
ci(deploy): rsync dist/widget.js to the VPS

Container reads /app/dist/widget.js via the ./dist volume mount, so the
widget bundle must arrive on the host alongside dist/dashboard/. One
extra glob entry on the scp step.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Build + commit the widget artefact

**Files:**
- Add: `dist/widget.js` (generated)

- [ ] **Step 1: Rebuild everything with the new scripts**

Run: `npm run build`
Expected:
- `dist/dashboard/` refreshed (hash in asset filenames may change).
- `dist/widget.js` created.

- [ ] **Step 2: Verify the widget is a valid IIFE**

Run: `node -e "console.log(require('fs').readFileSync('dist/widget.js','utf8').slice(0, 120))"`
Expected output starts with `(function(){var s=document.createElement('style')` (the inlined CSS prefix we injected).

- [ ] **Step 3: Commit the dist updates**

```bash
git add dist/
git commit -m "$(cat <<'EOF'
build: initial dist/widget.js artefact + refreshed dashboard bundle

First build of the standalone /widget.js IIFE. Committed alongside the
refreshed dashboard so CI rsync picks them up in one deploy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Push and verify CI deploys**

```bash
git push
```

After CI's deploy-core job finishes (~2 min), verify:

```bash
curl -sI https://devpanl.dev/widget.js | head -5
```

Expected:
```
HTTP/2 200
content-type: application/javascript; charset=utf-8
cache-control: public, max-age=300
```

And:

```bash
curl -s https://devpanl.dev/widget.js | head -c 80
```

Expected: starts with the inlined-CSS prefix `(function(){var s=document.createElement('style')`.

If the curl returns 404 or `widget not built`, the rsync step didn't upload `dist/widget.js` — check the deploy job log and re-verify the glob in `.github/workflows/deploy.yml`.

---

## Task 8: EDMS — switch to the CDN widget

**Files (in a separate repo `EDMS`):**
- Modify: `packages/server/src/portal-router.ts:100-215` (replace body of `renderDevPanelWidget`)

- [ ] **Step 1: Navigate to the EDMS repo**

```bash
cd /Users/franckbirba/DEV/EDMS
git pull --ff-only origin main
git checkout -b feature/widget-via-cdn
```

- [ ] **Step 2: Replace the `renderDevPanelWidget` function**

Open `packages/server/src/portal-router.ts`. Find `export function renderDevPanelWidget(...)` (starts near line 100). Replace the entire function body (everything from line 100 up to its closing `}` near line 215) with:

```typescript
/**
 * DevPanel bug/feature reporter — injected as a single <script> tag.
 * The bundle at devpanl.dev/widget.js reads data-api-key / data-api-url
 * from its own script element and auto-mounts the React widget.
 * Spec: dev-panel/docs/superpowers/specs/2026-04-22-standalone-widget-design.md
 */
export function renderDevPanelWidget(opts: { apiUrl?: string; apiKey?: string } | undefined): string {
  const apiUrl = opts?.apiUrl?.replace(/\/$/, '') ?? '';
  const apiKey = opts?.apiKey ?? '';
  if (!apiUrl || !apiKey) return '';
  return `<script src="${apiUrl}/widget.js" data-api-key="${escapeHtml(apiKey)}" data-api-url="${escapeHtml(apiUrl)}" async></script>`;
}
```

The old 115-line inline vanilla widget (HTML + CSS + JS) is gone. `escapeHtml` is still defined below in the same file — keep it.

- [ ] **Step 3: Build the EDMS server package**

Run: `npm run build -w packages/server`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/portal-router.ts
git commit -m "$(cat <<'EOF'
feat(devpanel): use the hosted /widget.js bundle from devpanl.dev

The 115-line vanilla-JS widget in renderDevPanelWidget() was a
compromise because the portal pages are server-rendered and couldn't
hydrate a React component. That's now moot: devpanl.dev/widget.js is
a self-contained IIFE that mounts the full React DevPanel on any
page, with all its features (annotations, inspect overlay, region
select, session recording, screenshot).

EDMS site now emits a single <script> tag and delegates everything
to the hosted widget. Single codebase, one screenshot pipeline,
parity with the admin.

Spec: dev-panel/docs/superpowers/specs/2026-04-22-standalone-widget-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Push and open a PR**

```bash
git push -u origin HEAD
gh pr create --title "Use hosted /widget.js bundle for the DevPanel embed" --body "$(cat <<'EOF'
## Summary
- Replace the 115-line vanilla-JS widget in `renderDevPanelWidget` with a single `<script>` tag pointing at `https://devpanl.dev/widget.js`.
- Public EDMS site now runs the full React DevPanel (same as the admin), with screenshot + annotations + inspect overlay etc.
- Depends on dev-panel PR that ships `/widget.js` (spec: `2026-04-22-standalone-widget-design.md`).

## Test plan
- [ ] Merge dev-panel widget PR first; confirm `https://devpanl.dev/widget.js` returns 200.
- [ ] Merge this, let CI deploy.
- [ ] Visit https://edms.epitools.bj/, confirm the FAB button appears.
- [ ] Submit a test bug with a screenshot; verify it lands in the DevPanel Inbox with the screenshot rendered in the thread.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: After merge, manual end-to-end**

Visit `https://edms.epitools.bj/`, click the FAB, submit a bug with a screenshot. Confirm:
1. Capture lands in `https://devpanl.dev/dashboard/captures` (the Inbox).
2. The thread shows a `system` message with the screenshot rendered inline.

If either fails, check:
- Browser console on edms.epitools.bj — is `/widget.js` returning 200? Any JS errors?
- Network tab — did `POST /api/captures` succeed? And `POST /api/captures/:id/messages`?

---

## Self-Review Checklist

**Spec coverage:**
- §Build: Tasks 1 + 2 + 3 (entry, Vite config, scripts).
- §Serving (Express route + cache headers): Tasks 4 + 5.
- §Consumer API (data attributes): Task 1 (entry file reads them).
- §EDMS migration: Task 8.
- §Error handling (missing key, missing dist, React runtime errors): addressed in Task 1 (missing-key warn) and Task 5 (404 when dist missing). React errors are DevPanel's own concern, unchanged.
- §Testing: Task 4 unit tests cover the route; Task 3 Step 3 + Task 7 Step 4 + Task 8 Step 6 cover manual verification.
- §Rollout (2 PRs, dev-panel first, then EDMS): Tasks 1–7 produce the dev-panel PR; Task 8 is the EDMS PR.
- CI rsync glob: Task 6.
- `dist/` commit: Task 7.

**Placeholder scan:** none — every code-changing step has explicit code.

**Type consistency:**
- Entry mounts via `createRoot(root).render(<DevPanel apiKey={apiKey} apiUrl={apiUrl} />)`; `DevPanel` accepts `{apiKey, apiUrl}` (per the existing `src/react/DevPanel.jsx:22-25`). ✓
- The `/widget.js` route reads `dist/widget.js`; `vite.widget.config.js` emits `dist/widget.js` (path matches). ✓
- CSS-inline prefix in Task 2 matches the validation in Task 7 Step 2 (both expect `(function(){var s=document.createElement('style')`). ✓
- `renderDevPanelWidget` keeps its `{apiUrl, apiKey}` signature in Task 8, so existing EDMS callers (`examples/landing-page/edms/server.ts:984`) don't break. ✓

Ready to execute.
