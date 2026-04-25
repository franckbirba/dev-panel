# Widget data-user on standalone script tag

**Date:** 2026-04-24
**Status:** Approved design, ready for plan
**Depends on:** `2026-04-24-widget-reporter-identity-design.md` (the `user` prop already exists on `<DevPanel>` and flows through to `captures.reporter_*` columns).

## Problem

The DevPanel widget carries reporter identity when embedded via React (`<DevPanel user={{...}} />`), but the **standalone `/widget.js` bundle** — used by EDMS and about to be used by Zeno — currently only reads `data-api-key`, `data-api-url`, and `data-environment` off its own `<script>` tag. There's no way for a vanilla-HTML host to tell the widget who the current user is. So Zeno (multi-user) can't yet tag captures with the reporter, and the `user` prop is dead code for standalone embeds.

## Goal

Let standalone hosts pass the current user identity via a `data-user` attribute on the `<script>` tag, parsed as JSON, forwarded to the existing `user` prop on `<DevPanel>`. No server change. No widget feature change. One-attribute extension of `widget-entry.jsx`.

## Non-goals

- No React-side change. `<DevPanel user={{...}} />` already works for apps that embed via npm.
- No schema/validation change. Server already validates the `reporter` object on POST `/api/captures`; the widget stays dumb and forwards whatever parses.
- No live-update on user change. `data-user` is read once at mount. If the host's user changes (login/logout within the same page load), a page reload is required to refresh the widget's reporter.
- No signed tokens. Same trust model as reporter identity: the host app is trusted, API key already authenticates the source.

## Design

### 1. Widget-entry reads and parses `data-user`

In `src/react/widget-entry.jsx`, alongside the existing dataset reads, add:

```js
let user = null;
if (script?.dataset?.user) {
  try {
    const parsed = JSON.parse(script.dataset.user);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      user = parsed;
    } else {
      console.warn('[DevPanel widget] data-user must be a JSON object; ignoring.');
    }
  } catch (err) {
    console.warn('[DevPanel widget] data-user is not valid JSON; ignoring.', err.message);
  }
}
```

Pass it through as the React `user` prop:

```jsx
createRoot(root).render(
  <DevPanel apiKey={apiKey} apiUrl={apiUrl} environment={environment} user={user} />
);
```

The `DevPanel` prop default is `user = null` (already shipped), so absent/invalid `data-user` collapses to the same behavior as today: no reporter field on captures.

### 2. Usage from a host

Plain HTML embed for a known user:

```html
<script src="https://devpanl.dev/widget.js"
        data-api-key="dp_..."
        data-api-url="https://devpanl.dev"
        data-environment="production"
        data-user='{"id":"u_42","name":"Alice","email":"alice@zeno.com"}'
        async></script>
```

Templated at build time by the host (Vite example for Zeno):

```html
<script src="%VITE_DEV_PANEL_URL%/widget.js"
        data-api-key="%VITE_DEV_PANEL_API_KEY%"
        data-environment="%VITE_DEV_PANEL_ENV%"
        async></script>
<script>
  // At page-load, the host reads its own session and stamps the tag
  // after the widget script. widget-entry runs on DOMContentLoaded so
  // both script tags have run by the time mount() queries for dataset.user.
  (function () {
    const u = window.__ZENO_CURRENT_USER__;
    if (!u) return;
    const s = document.querySelector('script[src*="/widget.js"][data-api-key]');
    if (s) s.dataset.user = JSON.stringify({ id: u.id, name: u.name, email: u.email });
  })();
</script>
```

(Each host wires this the way that matches its session model. The spec just defines the contract at the widget boundary.)

### 3. Wire format unchanged

The React `DevPanel` already forwards `user` through `buildCaptureRequestPayload` as `body.reporter` on POST `/api/captures`. The server already validates and persists. No route change, no DB change, no dashboard change. `data-user` is a pure client-side shim that fills an existing prop from an existing attribute.

### 4. Backward compatibility

| Case | Behavior |
|---|---|
| Old widget bundle (pre-change) | Ignores `data-user` entirely. Nothing breaks. |
| New bundle, no `data-user` attr | `user` stays `null`, capture posts without `reporter`. Same as today. |
| New bundle, `data-user='{"id":"u_1",...}'` | Forwarded to DevPanel → reporter stored + displayed. |
| `data-user='not json'` | `console.warn`, `user` stays `null`. Capture still posts (without reporter). |
| `data-user='"alice"'` (string-valued JSON) | `console.warn` ("must be a JSON object"), `user` stays `null`. |
| `data-user='[1,2,3]'` (array JSON) | Same — warn + ignore. |

## Files touched

- `src/react/widget-entry.jsx` — add the parse block + forward the prop (~10 lines).
- `dist/widget.js` — rebuilt bundle.
- `tests/react/widget-entry-data-user.test.jsx` *(new)* — 4 cases: valid JSON object, absent attr, invalid JSON, non-object JSON.

## Risks

- **Host sends sensitive PII.** Same risk as the existing reporter flow — covered by that spec's acknowledgement. Not new.
- **HTML attribute size.** Browsers tolerate at least several KB per attribute; a user object ≤1 KB is nowhere near a limit.
- **JSON quoting pitfalls.** Hosts must use single quotes around the attribute to keep double-quote JSON unescaped, or HTML-escape the whole thing. Documented in the usage section. Not a code concern.

## Out of scope

- Live user updates without reload (global `window.setDevPanelUser(...)` API or similar).
- Reading the user from a cookie / meta tag / localStorage. The `<script data-user>` pattern keeps the widget boundary explicit and the host in control of when + whether to send PII.
- Signed `data-user` payloads (JWT-style). Server already trusts the project API key.
