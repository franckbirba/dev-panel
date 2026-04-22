# Standalone DevPanel widget — `/widget.js`

**Status:** approved
**Author:** Claude (with Franck)
**Date:** 2026-04-22

## Problem

The React `DevPanel` component ships today as an npm ESM import (`@dev-panel/react`). Consumer apps that bundle React (EDMS admin, the devpanl dashboard itself) pick it up via Vite. But the EDMS public site is server-rendered by an Express portal router — it has no client JS bundle, no hydration, no React runtime. We couldn't mount the React widget there, so we wrote a separate 115-line vanilla-JS widget inline in EDMS `portal-router.ts`. Result: two codebases, divergent features, one of them re-implementing html2canvas integration and a basic modal — and doing it worse than the React one.

The EDMS public site is staff-only; there's no reason to ship a stripped-down widget. We want the full-feature React widget on every site, bundled once, distributed from a stable URL.

## Goal

One React widget, one build, one URL. Any site embeds with a single `<script>` tag that auto-mounts the full `DevPanel` component. The old EDMS vanilla widget goes away.

## Non-goals

- **No npm distribution** of this bundle. npm consumers keep using `import { DevPanel } from '@dev-panel/react'`. The `/widget.js` URL targets non-bundled sites.
- **No feature trimming.** All `DevPanel` features (screenshot, console/network/perf capture, annotations, inspect overlay, region select, session recording) ship in the public bundle. Staff-only surface, no reason to slim it down.
- **No config beyond `data-api-key` + `data-api-url`.** Position, colors, language are component defaults for now.
- **No Traefik changes.** The widget is served by the devpanel Express container like the dashboard.

## Design

### Build

New Vite config `vite.widget.config.js` alongside the existing dashboard build:

- **Entry:** `src/react/widget-entry.jsx` (new file, ~30 lines). Reads `data-api-key` / `data-api-url` from `document.currentScript`, creates a root `<div id="devpanel-widget-root">` on `document.body`, calls `createRoot(root).render(<DevPanel apiKey={...} apiUrl={...} />)` once the DOM is ready.
- **Format:** IIFE, global name `DevPanelWidget` (for debugging — nothing calls it externally).
- **Bundled:** React, ReactDOM, all DevPanel code. Nothing externalised.
- **Dynamic imports inlined:** `html2canvas` is dynamically imported inside `captureUtils.js`; Vite's `build.rollupOptions.output.inlineDynamicImports = true` rolls it into the main chunk. No second .js file.
- **CSS:** `cssCodeSplit: false` + `build.cssMinify: true`. The generated CSS is injected at runtime by a tiny inline stub prepended to the IIFE: on first execution it reads its own `__INLINE_CSS__` constant (replaced by Vite at build time with the CSS content via a post-build step) and inserts a `<style>` element into `document.head`. Implementation detail for the plan: a small Rollup `generateBundle` hook that reads the emitted `.css` asset, inlines it into the JS chunk as a string, and drops the separate CSS file. If this proves fiddly, fallback is a `vite-plugin-css-injected-by-js` dep — but try the manual hook first to keep deps minimal.
- **Output:** `dist/widget.js`. Single file, self-contained.

`package.json`:
- New `build:widget` script → `vite build --config vite.widget.config.js`.
- Rename current `build` to `build:dashboard`.
- New root `build` runs both in sequence: `npm run build:dashboard && npm run build:widget`.

### Serving

New route in `src/server/routes.js`, mounted on the router root (not under `/api`):

```js
router.get('/widget.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(path.resolve('./dist/widget.js'));
});
```

- `max-age=300` (5 min): widget updates propagate within 5 minutes without explicit cache-busting on consumer sites.
- `Content-Type: application/javascript` (Express infers from the `.js` extension).
- No CORS headers needed — `<script>` tags aren't CORS-gated.
- Mounted on the app root, alongside `/dashboard/*`. Reachable as `https://devpanl.dev/widget.js`.

The Dockerfile already copies `dist/` into the image. No infra change required. The CI rsync step (`source: "infra/*,docker-compose.yml,Makefile,dist/dashboard/**"`) needs one extra glob: `dist/widget.js`.

### Consumer API

```html
<script src="https://devpanl.dev/widget.js"
        data-api-key="dp_xxx"
        data-api-url="https://devpanl.dev"
        async></script>
```

Behavior:

1. Script loads (async — doesn't block page render).
2. Bootstrap reads `document.currentScript.dataset.apiKey` and `.apiUrl`.
3. If `apiKey` is missing: `console.warn` and exit. No mount.
4. Otherwise: once `document.body` is ready, inject `<div id="devpanel-widget-root">`, mount React, DevPanel renders its FAB.
5. Idempotent: if called twice (e.g. two script tags), second invocation detects existing root and no-ops.

### EDMS migration

Replace `renderDevPanelWidget()` in `packages/server/src/portal-router.ts` (currently ~115 lines of inline HTML/CSS/JS) with:

```ts
export function renderDevPanelWidget(opts: { apiUrl?: string; apiKey?: string } | undefined): string {
  const apiUrl = opts?.apiUrl?.replace(/\/$/, '') ?? '';
  const apiKey = opts?.apiKey ?? '';
  if (!apiUrl || !apiKey) return '';
  return `<script src="${apiUrl}/widget.js" data-api-key="${escapeHtml(apiKey)}" data-api-url="${escapeHtml(apiUrl)}" async></script>`;
}
```

Same function signature, same callers (`examples/landing-page/edms/server.ts:984`), same env vars (`DEV_PANEL_URL`, `DEV_PANEL_API_KEY`). Old code deleted.

### Error handling

- **`/widget.js` not built:** Express returns 404. Visible in browser console, site still works.
- **Missing or bad apiKey:** bootstrap warns, widget doesn't mount, no throws.
- **html2canvas CDN fetch fails:** DevPanel already handles this (logged, screenshot button fails gracefully). Same as in the admin today.
- **React runtime errors:** React's own error boundaries inside DevPanel; host page unaffected because the widget runs in its own root.

### Testing

1. **Build smoke:** CI runs `npm run build` which now produces `dist/widget.js`. If the file doesn't exist or is tiny, CI fails at the existing Docker build step when the image tries to copy `dist/`.
2. **Integration test (optional, follow-up):** Playwright page loads the built widget via `<script>`, asserts the FAB button appears. Deferred — manual verification suffices for v1.
3. **Manual:** After deploy, visit `https://edms.epitools.bj/`, confirm FAB appears, submit a test bug, verify it lands in the Inbox with screenshot.

### Rollout

Single PR in `dev-panel`, single PR in `EDMS`, merged in order:

1. `dev-panel` PR: new Vite config, new entry file, new build script, new Express route, CI rsync glob. Deploy → `https://devpanl.dev/widget.js` live.
2. `EDMS` PR: `portal-router.ts` simplification. Deploy → EDMS site switches to the CDN widget.
3. Follow-up (not in scope): `zeno.epitools.bj`, `candidat.epitools.bj` can now embed the same way if/when someone wants bug reporting there.

## Notes

- Bundle size: rough estimate 300–500 kB minified+gzipped (React 19 + ReactDOM + html2canvas lazy-loaded from CDN at first screenshot, not in the bundle + all DevPanel surface code). Widget loads `async`, doesn't block page render, and is staff-only so aggressive size optimization isn't critical.
- Future cache-busting: if `max-age=300` becomes a problem (a bad widget version leaks into prod and persists for 5 min), we can shorten it or switch to ETag revalidation in a follow-up. Not worth optimising preemptively.
- The React widget's existing `captureUtils.js` uses `takeScreenshot()` which dynamically imports html2canvas. Vite's `inlineDynamicImports: true` preserves that but folds the chunk into the main bundle. If bundle size becomes a problem, revisit by leaving html2canvas as an external CDN load (same as the current vanilla EDMS widget does).
