# Design — Migrate `devpanl.dev` dashboard auth to Google SSO

Status: design
Date: 2026-04-25
Owner: Franck

## Problem

`devpanl.dev` (the devpanel-api container) is the only internal app still gated by a bespoke **Telegram-relayed OTP + Lucia session cookie** flow (`src/server/auth.js`, `src/server/middleware/require-auth.js`). It is hardcoded single-user (`SINGLE_USER_ID = 'franck'`), so collaborators cannot get in without sharing Franck's Telegram code.

Every other internal UI on the stack — `traefik.devpanl.dev`, `queues.devpanl.dev` (bull-board), `ui.devpanl.dev` (storybook) — is already gated by the **`oauth-google@docker` Traefik middleware** in `docker-compose.yml`, served by `thomseddon/traefik-forward-auth` at `auth.devpanl.dev`. Allowlist today is a single literal in compose env (`WHITELIST: franckbirba@gmail.com`); the canonical allowlist file `infra/config/oauth2-proxy-emails.txt` exists but is unused.

The migration consolidates devpanl.dev onto the same gate, kills the OTP code path, and turns "invite a user" into "add an email to the allowlist file + redeploy".

## Constraints (hard, do not break)

- **`/widget.js` must stay public.** Cross-origin `<script>` embeds from `edms.epitools.bj`, `candidat.epitools.bj`, `zeno.epitools.bj` and any other staff site. No oauth, no cookie.
- **`/api/captures` and `/api/threads/capture/:id/messages` must stay open to the widget.** They authenticate with `X-API-Key` (project key). The widget cannot do an oauth dance against `auth.devpanl.dev` — it lives on a third-party origin.
- **All other `/api/*` M2M routes must stay reachable for the worker on the agents host** (`X-API-Key` for project routes, `X-Admin-Key` for admin routes). The agents-host worker is not a browser; it cannot pass through oauth.
- **The MCP server** (`src/mcp/server.js`) and the CLI also call `/api/*` with `X-Admin-Key` — same constraint.
- **CORS allowlist** (`ALLOWED_ORIGINS`) must continue to permit cross-origin widget POSTs from staff sites.

## Non-goals

- Per-user *data isolation* inside devpanel. Authorization stays coarse: "you're on the allowlist → you see everything Franck sees". Multi-tenant capture-by-user is a separate spec.
- Migrating the agents-host worker / MCP / CLI off `X-Admin-Key` / `X-API-Key`. Those stay M2M.
- Replacing `traefik-forward-auth` with `oauth2-proxy`. The compose comment already explains why thomseddon's variant is preferred (preserves 401, emits real 307).

## Architecture

### Routing split (Traefik)

Today:

```
Host(`devpanl.dev`)  →  devpanel-api:3030     # one router, no oauth middleware
```

After:

```
Host(`devpanl.dev`) && (PathPrefix(`/api`) || Path(`/widget.js`) || PathPrefix(`/health`))
    → devpanel-api:3030                        # M2M router, NO oauth, priority 200

Host(`devpanl.dev`)
    → devpanel-api:3030                        # SPA router, oauth-google@docker middleware, priority 100
```

Two routers, same backend service. Traefik picks the M2M router first because of the explicit higher priority. Everything else (`/`, `/dashboard/*`, the legacy `/auth/*` path, static dashboard assets) hits the SPA router and gets the 307-to-Google flow if the user has no `_forward_auth` cookie.

`/health` stays unauthenticated (uptime-kuma probes it).

### Allowlist file as source of truth

Today the WHITELIST is a literal in compose env. After:

- `infra/config/oauth2-proxy-emails.txt` becomes the canonical file (one email per line, `#` comments tolerated).
- The `oauth2-proxy` (traefik-forward-auth) container reads that file via a `WHITELIST` env value derived at compose interpolation time, OR — simpler — mounts the file and uses thomseddon's `--whitelist` repeated CLI flags via an entrypoint shim. **Decision: simplest path** — render the file to a comma-separated `WHITELIST` env var via a tiny `infra/scripts/render-whitelist.sh` invoked by the deploy workflow before `docker compose up -d --no-deps oauth2-proxy`.
- Adding an invitee = `git add infra/config/oauth2-proxy-emails.txt && git push`. The deploy CI step refreshes only `oauth2-proxy` (no devpanel restart needed).

### Server-side cleanup

After the gate moves to Traefik, the Express app no longer needs the OTP / Lucia code path:

- **Remove** `src/server/auth.js`, `src/server/auth-routes.js`, the `app.use('/auth', ...)` mount in `src/server/index.js`, and the Lucia branch of `src/server/middleware/require-auth.js`. Keep the project API-key + admin-key branches; rename the middleware to `requireProjectOrAdmin` (or just inline — fewer than 5 routes use it today).
- **Remove** the `denyChallenge` MCP-callable endpoint and the `auth_deny` MCP tool (the [auth] Telegram message protocol disappears with the OTP).
- **Remove** `lucia`, `@lucia-auth/adapter-sqlite`, `cookie-parser` from `package.json` if no other route depends on them. (Quick grep in plan step.)
- **Replace** the `/api/projects` list endpoint's auth: today it allows the cookie session OR an admin key. After: cookie is gone, so the SPA must be hydrated differently. **Decision:** the SPA reads `X-Forwarded-User` (set by traefik-forward-auth on every proxied request) and treats *any* presence of that header as "authorized human" — the gate is Traefik, the app trusts it. Express reads `req.headers['x-forwarded-user']` to gate `/api/projects` and `/api/projects/summary`. No DB user table, no Lucia, no session. Single env var `TRUST_FORWARDED_USER=true` in compose to make the trust explicit (off by default for local dev so curl-without-traefik still 401s on those endpoints).
- **Add** a small `requireForwardedUser` middleware in `src/server/middleware/require-forwarded-user.js`. Used only on the two `/api/projects*` endpoints that the SPA calls to bootstrap. Everything else stays on `authenticateProject` / `authenticateAdmin`.

### Dashboard SPA changes

- **Remove** the OTP login screen (`src/dashboard/views/login-view.jsx`) and the `useAuth` hook polling `/auth/me` (`src/dashboard/lib/use-auth.js`). When the user lands on `/dashboard/*`, oauth has already happened upstream — there is no "logged out" state to render. If `X-Forwarded-User` is absent (i.e. someone hit the bare API directly), the bootstrap fetch to `/api/projects` returns 401 and the SPA renders a simple "you're not authenticated; visit https://devpanl.dev to log in" message.
- **Keep** the project-store hydration: after the SPA loads, fetch `/api/projects` with `credentials: 'omit'` (no cookie needed; traefik-forward-auth handles auth via its own `_forward_auth` cookie which is automatic), get back the projects with their API keys, write to localStorage, proceed exactly as today. No code change in `src/dashboard/lib/projects-store.js` beyond removing the `credentials: 'include'` line.
- **Add** a "Logout" entry in the topbar that hits `https://auth.devpanl.dev/_oauth/logout` (thomseddon's logout URL). On success, the next request to devpanl.dev will re-trigger the Google flow.

### Telegram OTP cleanup

- The `[auth]` message protocol disappears. Update `.agents/shelly/SOUL.md`: remove the entire "Auth dashboard — messages [auth]" section.
- Update `CLAUDE.md` if it references the OTP flow (currently the Shelly section does not — only the SOUL does).

## Data flow (after migration)

```
Browser (Franck or invitee)
   │
   │  GET https://devpanl.dev/dashboard/today
   ▼
Traefik (router: SPA, middleware: oauth-google@docker)
   │
   │  no _forward_auth cookie?
   ▼
traefik-forward-auth (auth.devpanl.dev)
   │  → 307 to https://accounts.google.com/...
   │  (user signs in with Google, comes back with code)
   │  → checks email against WHITELIST env (rendered from emails.txt)
   │  → sets _forward_auth cookie on devpanl.dev domain
   ▼
Browser → GET https://devpanl.dev/dashboard/today (with cookie)
   │
Traefik forwards to devpanel-api with X-Forwarded-User: <email>
   │
devpanel-api serves dist/dashboard/index.html (no auth check needed; trust Traefik)
   │
SPA boots → fetch /api/projects (router: M2M, but requireForwardedUser middleware)
   │  → server reads X-Forwarded-User, returns project list with api_keys
   │
SPA writes api_keys to localStorage, calls /api/captures, /api/today, etc.
with X-API-Key as today.
```

Widget flow (unchanged):

```
edms.epitools.bj page → <script src="https://devpanl.dev/widget.js">
   │
Traefik (router: M2M, no oauth) → devpanel-api → /widget.js
   │
widget POSTs to https://devpanl.dev/api/captures with X-API-Key
   │
Traefik (router: M2M, no oauth) → devpanel-api → authenticateProject
```

## Failure modes

| Scenario | Behavior |
|---|---|
| Invitee not on allowlist signs in | traefik-forward-auth returns 401, no cookie set, browser shows the proxy's "unauthorized" page. Add their email to `oauth2-proxy-emails.txt`. |
| oauth2-proxy container down | All SPA requests return whatever traefik-forward-auth's failure mode is (typically 502). Widget + worker (`/api/*`) keep working — different router, no middleware. |
| traefik-forward-auth misconfigured (no `X-Forwarded-User` header passed) | `/api/projects` returns 401 → SPA shows "not authenticated" message. Existing localStorage entries still allow `/api/captures` etc. to work via X-API-Key (degraded but functional). |
| Someone hits `https://devpanl.dev/api/captures` from a browser without a project key | 401 from `authenticateProject`. Same as today. |
| Local dev (`localhost:3030`, no Traefik) | `TRUST_FORWARDED_USER` is unset → `requireForwardedUser` rejects → set it to `true` in `.env` for local dev (combined with a dev-only `X-Forwarded-User: dev@localhost` header injected by the SPA when `import.meta.env.DEV`), or use the admin key path on `/api/projects`. |
| Header spoofing | Anyone who can hit the devpanel-api container directly (bypassing Traefik) can forge `X-Forwarded-User`. Mitigation: container only listens on the docker network (no host port), Traefik strips inbound `X-Forwarded-User` from clients before adding its own (default thomseddon behavior), and `TRUST_FORWARDED_USER` is off by default. Document this in `infra/INDEX.md`. |

## Testing

- **Unit:** `requireForwardedUser` middleware — pass through when `X-Forwarded-User` present and `TRUST_FORWARDED_USER=true`; 401 otherwise.
- **Manual / browser, on staging or after deploy:**
  - Incognito hit `https://devpanl.dev/dashboard/today` → bounces through Google → lands on dashboard.
  - Sign out via the new logout button → next visit re-triggers Google.
  - Hit `https://devpanl.dev/widget.js` from `edms.epitools.bj` browser session → 200, no oauth.
  - Worker on agents host posts a capture via X-API-Key → 200.
  - MCP `auth_deny` tool: gracefully removed (or left as a no-op returning `{ok:false, reason:'auth_deprecated'}`).
- **Allowlist test:** add a throwaway gmail to `oauth2-proxy-emails.txt`, deploy, sign in from another device, confirm access; remove, deploy, confirm 401.

## Migration / rollout

Single deploy step (no two-phase). Order inside the deploy:

1. Render `oauth2-proxy-emails.txt` → comma-separated `WHITELIST` env, pass to `oauth2-proxy` container via an env file (`.env.oauth2-proxy`, generated, gitignored).
2. `docker compose up -d --no-deps oauth2-proxy` (refresh allowlist).
3. `docker compose up -d --no-deps devpanel` (refresh code: M2M paths only, no Lucia).
4. Traefik dynamically reloads from new compose labels (provider=docker, watch=true).

Rollback: `git revert` the deploy commit, redeploy. The Lucia DB tables (`user`, `session` in master sqlite) are not dropped, so reverting puts the OTP flow back instantly. (After a week of confidence, drop the tables in a follow-up migration.)

## Files touched

- `docker-compose.yml` — split devpanl.dev into two routers (M2M + SPA); add `oauth-google@docker` middleware to the SPA router; switch `oauth2-proxy` `WHITELIST` to read from generated env file.
- `infra/config/oauth2-proxy-emails.txt` — initial seed (Franck + first invitees).
- `infra/scripts/render-whitelist.sh` *(new)* — reads emails.txt, writes `.env.oauth2-proxy`.
- `.github/workflows/deploy.yml` — invoke `render-whitelist.sh` before the `docker compose up -d --no-deps oauth2-proxy devpanel` step.
- `src/server/index.js` — drop `app.use('/auth', ...)`; drop `initAuth()`; drop `cookieParser` import if unused elsewhere.
- `src/server/middleware/require-auth.js` — drop the Lucia branch; rename to `requireProjectOrAdmin` and update callers (3 spots in `routes.js`).
- `src/server/middleware/require-forwarded-user.js` *(new)* — checks `req.headers['x-forwarded-user']` when `TRUST_FORWARDED_USER=true`.
- `src/server/routes.js` — swap the cookie-gated routes (`/projects` list, `/projects/summary`) onto `requireForwardedUser`; remove `/auth/deny` MCP path if any references.
- `src/server/auth.js` — delete.
- `src/server/auth-routes.js` — delete.
- `src/mcp/server.js` — drop the `auth_deny` tool (search and confirm; if it's there, remove).
- `src/dashboard/views/login-view.jsx` — delete.
- `src/dashboard/lib/use-auth.js` — delete.
- `src/dashboard/app.jsx` — drop login-view routing; drop useAuth wrapper.
- `src/dashboard/components/topbar.jsx` — add Logout button hitting `https://auth.devpanl.dev/_oauth/logout`.
- `src/dashboard/lib/projects-store.js` — drop `credentials: 'include'` (oauth cookie is on the auth subdomain, not relevant here).
- `package.json` — remove `lucia`, `@lucia-auth/adapter-sqlite` if unused. Keep `cookie-parser` if any other route uses it (likely not).
- `.agents/shelly/SOUL.md` — remove the "Auth dashboard — messages [auth]" section.
- `CLAUDE.md` — sweep for OTP / `/auth/start` references; remove.

## Out of scope (followups)

- Per-user data isolation, capture authorship by Google email, audit log of who-did-what.
- Drop the Lucia `user` / `session` SQLite tables (after a week of stability).
- A self-service "request access" page that DMs Franck on Telegram when an unknown gmail tries to sign in.
