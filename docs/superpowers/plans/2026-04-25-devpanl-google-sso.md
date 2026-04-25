# devpanl.dev Google SSO Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `devpanl.dev` dashboard auth from bespoke Telegram-OTP + Lucia onto the existing `oauth-google@docker` Traefik middleware (same gate as bull-board / storybook), so adding a teammate becomes "add an email to `infra/config/oauth2-proxy-emails.txt` and push".

**Architecture:** Split `Host(devpanl.dev)` into two Traefik routers — a high-priority **M2M router** (`/api/*`, `/widget.js`, `/health`) with no oauth (keeps widget + worker + MCP working with `X-API-Key`/`X-Admin-Key` as today) and a **SPA router** (everything else) gated by `oauth-google@docker`. After the gate moves to Traefik, delete Lucia + the OTP code path. The two `/api/*` routes the SPA needs to bootstrap (`/api/projects`, `/api/projects/summary`) get a new `requireForwardedUser` middleware that trusts Traefik's `X-Forwarded-User` header.

**Tech Stack:** Express, Traefik v2.11, `thomseddon/traefik-forward-auth:2`, React (dashboard SPA), better-sqlite3 (master DB).

**Spec:** `docs/superpowers/specs/2026-04-25-devpanl-google-sso-design.md`

---

## File Structure

**Create:**
- `src/server/middleware/require-forwarded-user.js` — gate that checks `X-Forwarded-User` when `TRUST_FORWARDED_USER=true`.
- `tests/server/require-forwarded-user.test.js` — unit tests for the new middleware.
- `infra/scripts/render-whitelist.sh` — reads `infra/config/oauth2-proxy-emails.txt`, writes a comma-separated `WHITELIST` line into `.env.oauth2-proxy`.
- `infra/config/oauth2-proxy-emails.txt` — canonical allowlist (already exists per memory; edit if so, create if not).

**Modify:**
- `docker-compose.yml` — split the devpanel router; switch `oauth2-proxy` to read the rendered env file.
- `.github/workflows/deploy.yml` — invoke `render-whitelist.sh` and refresh `oauth2-proxy` before `devpanel`.
- `src/server/index.js` — drop `cookieParser`, `initAuth`, `/auth` mount.
- `src/server/middleware/require-auth.js` — drop the Lucia branch; keep project-key + admin-key.
- `src/server/routes.js` — switch the two cookie-gated routes onto the new `requireForwardedUser` middleware.
- `src/dashboard/app.jsx` — drop `useAuth` gate, drop `LoginView`, drop `credentials: 'include'` on the bootstrap fetch.
- `src/dashboard/lib/projects-store.js` — drop `credentials: 'include'` on `hydrateFromSession`.
- `src/dashboard/components/topbar.jsx` — add a Logout link to `https://auth.devpanl.dev/_oauth/logout`.
- `src/mcp/server.js` — remove the `auth_deny` MCP tool (no more OTP to deny).
- `package.json` — remove `lucia`, `@lucia-auth/adapter-sqlite`, `cookie-parser`.
- `.agents/shelly/SOUL.md` — remove the "Auth dashboard — messages [auth]" section.
- `infra/INDEX.md` — note the header-spoofing mitigation (`TRUST_FORWARDED_USER` off by default).

**Delete:**
- `src/server/auth.js`
- `src/server/auth-routes.js`
- `src/dashboard/views/login-view.jsx`
- `src/dashboard/lib/use-auth.js`

---

## Task 1: Add `require-forwarded-user` middleware (TDD)

**Files:**
- Create: `src/server/middleware/require-forwarded-user.js`
- Create: `tests/server/require-forwarded-user.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/server/require-forwarded-user.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { requireForwardedUser } from '../../src/server/middleware/require-forwarded-user.js';

function mkRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

describe('requireForwardedUser', () => {
  const original = process.env.TRUST_FORWARDED_USER;
  afterEach(() => {
    if (original === undefined) delete process.env.TRUST_FORWARDED_USER;
    else process.env.TRUST_FORWARDED_USER = original;
  });

  it('rejects with 401 when TRUST_FORWARDED_USER is not set', () => {
    delete process.env.TRUST_FORWARDED_USER;
    const req = { headers: { 'x-forwarded-user': 'someone@example.com' } };
    const res = mkRes();
    let nextCalled = false;
    requireForwardedUser(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/forwarded user/i);
  });

  it('rejects with 401 when X-Forwarded-User is missing', () => {
    process.env.TRUST_FORWARDED_USER = 'true';
    const req = { headers: {} };
    const res = mkRes();
    let nextCalled = false;
    requireForwardedUser(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('passes through and sets req.user when both are set', () => {
    process.env.TRUST_FORWARDED_USER = 'true';
    const req = { headers: { 'x-forwarded-user': 'franckbirba@gmail.com' } };
    const res = mkRes();
    let nextCalled = false;
    requireForwardedUser(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(req.user).toEqual({ type: 'forwarded_user', email: 'franckbirba@gmail.com' });
  });

  it('treats whitespace-only header as missing', () => {
    process.env.TRUST_FORWARDED_USER = 'true';
    const req = { headers: { 'x-forwarded-user': '   ' } };
    const res = mkRes();
    let nextCalled = false;
    requireForwardedUser(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/require-forwarded-user.test.js`
Expected: FAIL with `Cannot find module './middleware/require-forwarded-user.js'` (or equivalent import error).

- [ ] **Step 3: Write minimal implementation**

Create `src/server/middleware/require-forwarded-user.js`:

```js
// Trust Traefik's X-Forwarded-User header (set by traefik-forward-auth after
// Google SSO). Off by default so a curl directly against the container — or
// local dev without Traefik — does not auto-authenticate. Enable explicitly
// in the production docker-compose env: TRUST_FORWARDED_USER=true.
//
// CRITICAL: this only safe when the upstream proxy (Traefik) strips any
// inbound X-Forwarded-User from the client before adding its own. With
// thomseddon/traefik-forward-auth + Traefik's default ForwardAuth, that's
// the case. Document the deployment assumption in infra/INDEX.md.
export function requireForwardedUser(req, res, next) {
  if (process.env.TRUST_FORWARDED_USER !== 'true') {
    return res.status(401).json({ error: 'forwarded user trust disabled' });
  }
  const raw = req.headers['x-forwarded-user'];
  const email = typeof raw === 'string' ? raw.trim() : '';
  if (!email) {
    return res.status(401).json({ error: 'forwarded user header missing' });
  }
  req.user = { type: 'forwarded_user', email };
  next();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/require-forwarded-user.test.js`
Expected: PASS, all 4 cases.

- [ ] **Step 5: Commit**

```bash
git add src/server/middleware/require-forwarded-user.js tests/server/require-forwarded-user.test.js
git commit -m "feat(auth): require-forwarded-user middleware for SSO bootstrap"
```

---

## Task 2: Switch `/api/projects` and `/api/projects/summary` onto the new middleware

**Files:**
- Modify: `src/server/routes.js` (around lines 518–625, where `requireAuth` is used today on the project list endpoints)

Today the cookie-or-key middleware `requireAuth` (from `./middleware/require-auth.js`) gates two routes used by the SPA bootstrap. With SSO, only the new `requireForwardedUser` should authenticate the human; the admin-key path stays for the CLI.

- [ ] **Step 1: Inspect current usage**

Run: `grep -n "requireAuth\|requireForwardedUser" src/server/routes.js`
Expected: 2-3 hits on `requireAuth` (likely lines ~523 and ~611). Note the exact line numbers and surrounding code.

- [ ] **Step 2: Add the new import**

Edit `src/server/routes.js`. Find:

```js
import { requireAuth } from './middleware/require-auth.js';
```

Replace with:

```js
import { requireAuth } from './middleware/require-auth.js';
import { requireForwardedUser } from './middleware/require-forwarded-user.js';
```

- [ ] **Step 3: Compose the SPA-bootstrap gate**

In `src/server/routes.js`, immediately after `function authenticateProject(...)` (around line 134) add:

```js
// SPA bootstrap auth: accept (a) admin key (CLI) OR (b) trusted forwarded
// user (browser through Traefik SSO). Plain project API keys are NOT
// accepted here — these routes return ALL projects, which a single project
// key must not unlock.
function authenticateSpaBootstrap(req, res, next) {
  // Admin key path — short-circuit if header matches.
  const adminKey = req.headers['x-admin-key'];
  const configured = process.env.ADMIN_API_KEY;
  if (adminKey && configured) {
    const a = Buffer.from(adminKey);
    const b = Buffer.from(configured);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      req.user = { type: 'admin_key' };
      return next();
    }
  }
  // Otherwise require the forwarded-user header.
  return requireForwardedUser(req, res, next);
}
```

- [ ] **Step 4: Swap the route gates**

In `src/server/routes.js`, find every use of `requireAuth` and replace with `authenticateSpaBootstrap`.

Expected hits (verify with grep first — line numbers may have shifted):

```js
router.get('/projects', authLimiter, requireAuth, (req, res) => {
```

Becomes:

```js
router.get('/projects', authLimiter, authenticateSpaBootstrap, (req, res) => {
```

Repeat for every other `requireAuth` occurrence in the file.

- [ ] **Step 5: Verify no `requireAuth` references remain**

Run: `grep -n "requireAuth" src/server/routes.js`
Expected: only the import line. If any route still references it, replace it.

- [ ] **Step 6: Manual smoke (against running dev server, optional but recommended)**

```bash
# in one shell
TRUST_FORWARDED_USER=true ADMIN_API_KEY=devkey node bin/dev-panel.js serve
```

```bash
# in another
curl -s -o /dev/null -w "no-header: %{http_code}\n" http://localhost:3030/api/projects
curl -s -o /dev/null -w "with-header: %{http_code}\n" -H 'X-Forwarded-User: franckbirba@gmail.com' http://localhost:3030/api/projects
curl -s -o /dev/null -w "with-admin: %{http_code}\n" -H 'X-Admin-Key: devkey' http://localhost:3030/api/projects
```

Expected: `no-header: 401`, `with-header: 200`, `with-admin: 200`.

- [ ] **Step 7: Commit**

```bash
git add src/server/routes.js
git commit -m "feat(auth): gate /api/projects on forwarded-user or admin key"
```

---

## Task 3: Strip Lucia from server bootstrap

**Files:**
- Modify: `src/server/index.js`
- Modify: `src/server/middleware/require-auth.js`
- Delete: `src/server/auth.js`
- Delete: `src/server/auth-routes.js`

After Task 2, no route uses `requireAuth`'s cookie branch. Remove the dead path entirely (rather than leaving a vestigial cookie-checker that could mask bugs).

- [ ] **Step 1: Remove auth wiring from `src/server/index.js`**

Edit `src/server/index.js`. Delete these lines (line numbers from current HEAD; verify with grep):

```js
import cookieParser from 'cookie-parser';
```
```js
import { initAuth } from './auth.js';
import { createAuthRouter } from './auth-routes.js';
```
```js
  initAuth(getMasterDatabase());
```
```js
  app.use(cookieParser());
```
```js
  // Auth (Lucia sessions + Telegram OTP)
  app.use('/auth', createAuthRouter());
```

After edits, confirm the file no longer references `cookieParser`, `initAuth`, or `createAuthRouter`:

```bash
grep -n "cookieParser\|initAuth\|createAuthRouter\|auth-routes\|auth\.js" src/server/index.js
```

Expected: no hits.

- [ ] **Step 2: Slim `src/server/middleware/require-auth.js` to project-or-admin only**

Replace the entire file with:

```js
// Project API key OR admin key. The SPA's per-route auth uses the project
// key from localStorage (X-API-Key), the CLI uses X-Admin-Key. The Google
// SSO gate in front of the SPA is enforced by Traefik, not Express — see
// require-forwarded-user.js for the SPA-bootstrap gate.
import { timingSafeEqual } from 'crypto';
import { getProjectByApiKey } from '../db.js';

export async function requireAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey) {
    const project = getProjectByApiKey(apiKey);
    if (project) {
      req.project = project;
      req.user = { type: 'project_key', project_id: project.id };
      return next();
    }
  }
  const adminKey = req.headers['x-admin-key'];
  const configured = process.env.ADMIN_API_KEY;
  if (adminKey && configured) {
    const a = Buffer.from(adminKey);
    const b = Buffer.from(configured);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      req.user = { type: 'admin_key' };
      return next();
    }
  }
  return res.status(401).json({ error: 'Authentication required' });
}
```

- [ ] **Step 3: Delete the OTP files**

```bash
rm src/server/auth.js src/server/auth-routes.js
```

- [ ] **Step 4: Verify nothing imports them**

```bash
grep -rn "from './auth.js'\|from './auth-routes.js'\|from '../auth.js'\|from '../auth-routes.js'" src/
```

Expected: no hits.

- [ ] **Step 5: Boot the server to confirm it still starts**

Run: `node -e "import('./src/server/index.js').then(m => { const { app } = m.createServer('./.tmp-storage'); console.log('boot ok, routes mounted'); })"`

Expected: `boot ok, routes mounted` and no error. Clean up: `rm -rf .tmp-storage`.

- [ ] **Step 6: Commit**

```bash
git add src/server/index.js src/server/middleware/require-auth.js
git rm src/server/auth.js src/server/auth-routes.js
git commit -m "refactor(auth): remove Lucia + OTP code path"
```

---

## Task 4: Drop the `auth_deny` MCP tool

**Files:**
- Modify: `src/mcp/server.js` (around line 820, "Auth dashboard — auth_verify / auth_deny")

There is no more challenge to deny — the OTP flow is gone. Drop the tool so callers get a "tool not found" instead of a 500.

- [ ] **Step 1: Inspect the current block**

Run: `grep -n "auth_deny\|auth_verify\|AUTH_API_BASE" src/mcp/server.js`
Note the line range to remove. Read 30 lines of context with `sed -n '<start>,<end>p' src/mcp/server.js` to make sure you grab the full tool definition (including its `inputSchema` and the trailing `,` if it's mid-array).

- [ ] **Step 2: Remove the `auth_deny` tool definition**

Edit `src/mcp/server.js`. Delete the entire `auth_deny` tool registration block. If the block is in an array of tools, ensure the surrounding commas/brackets remain valid. If `AUTH_API_BASE` is only used by `auth_deny`, remove its declaration too.

- [ ] **Step 3: Verify the file parses**

Run: `node --check src/mcp/server.js`
Expected: no output (success).

- [ ] **Step 4: Verify nothing else references it**

Run: `grep -n "auth_deny\|/auth/deny" src/mcp/server.js src/server/`
Expected: no hits.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.js
git commit -m "refactor(mcp): drop auth_deny tool — OTP flow removed"
```

---

## Task 5: Strip `useAuth` / `LoginView` from the SPA

**Files:**
- Modify: `src/dashboard/app.jsx`
- Modify: `src/dashboard/lib/projects-store.js`
- Delete: `src/dashboard/views/login-view.jsx`
- Delete: `src/dashboard/lib/use-auth.js`

The dashboard no longer needs to render a login screen — Traefik bounces the user to Google before the SPA loads. Hydration becomes "fetch `/api/projects` immediately on mount".

- [ ] **Step 1: Remove the auth gate from `src/dashboard/app.jsx`**

Edit `src/dashboard/app.jsx`. Make these edits:

Remove imports:

```js
import { useAuth } from "@/lib/use-auth";
import { LoginView } from "@/views/login-view";
```

Remove the `useAuth` call and the comment block above it (currently lines ~48-51):

```js
  // Auth gate — probe /auth/me (uses Lucia session cookie). If not authed,
  // render LoginView (Telegram OTP). The per-project api_key in localStorage
  // is still used for scoping requests but no longer authenticates the human.
  const { status: authStatus } = useAuth("");
```

Replace the hydration `useEffect` (currently lines ~70-75):

```js
  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    hydrateFromSession("").then((n) => {
      if (n > 0) setProjectVersion((v) => v + 1);
    });
  }, [authStatus]);
```

With:

```js
  // Traefik enforces SSO before the SPA loads, so by the time we mount we
  // know the user is authenticated. Hydrate the project list (which the
  // server gates on X-Forwarded-User).
  useEffect(() => {
    hydrateFromSession("").then((n) => {
      if (n > 0) setProjectVersion((v) => v + 1);
    });
  }, []);
```

Remove the auth-gate render block (currently lines ~213-219):

```js
  // ── Auth gate (Telegram-via-Shelly OTP) ─────────────────
  if (authStatus === 'unknown') {
    return <div className="flex items-center justify-center h-screen text-sm text-muted-foreground">Connexion…</div>;
  }
  if (authStatus === 'unauthenticated') {
    return <LoginView apiUrl="" />;
  }
```

Delete those 7 lines outright.

- [ ] **Step 2: Drop `credentials: 'include'` from `hydrateFromSession`**

Edit `src/dashboard/lib/projects-store.js`. Find:

```js
    const res = await fetch(`${apiUrl}/api/projects`, { credentials: 'include' });
```

Replace with:

```js
    // Traefik SSO injects X-Forwarded-User; no cookie needed (the
    // _forward_auth cookie is on auth.devpanl.dev and not relevant here).
    const res = await fetch(`${apiUrl}/api/projects`);
```

- [ ] **Step 3: Delete the dead files**

```bash
rm src/dashboard/views/login-view.jsx src/dashboard/lib/use-auth.js
```

- [ ] **Step 4: Verify nothing imports them**

```bash
grep -rn "use-auth\|useAuth\|login-view\|LoginView" src/dashboard
```

Expected: no hits.

- [ ] **Step 5: Build the dashboard to confirm no broken imports**

Run: `npm run build:dashboard 2>&1 | tail -20`

(If `package.json` has no `build:dashboard` script, use whatever script builds `dist/dashboard/index.html` — likely `npm run build` or `vite build`. Check `package.json` first.)

Expected: build succeeds, `dist/dashboard/index.html` regenerated.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/app.jsx src/dashboard/lib/projects-store.js dist/dashboard
git rm src/dashboard/views/login-view.jsx src/dashboard/lib/use-auth.js
git commit -m "feat(dashboard): drop OTP login — Traefik SSO is the gate"
```

---

## Task 6: Add the Logout link to the topbar

**Files:**
- Modify: `src/dashboard/components/topbar.jsx`

- [ ] **Step 1: Inspect the current topbar**

Run: `grep -n "Logout\|logout\|<button\|<a " src/dashboard/components/topbar.jsx | head -20`
Note where to insert the link (typically near the right-hand controls / settings icon).

- [ ] **Step 2: Add the Logout link**

Insert in `src/dashboard/components/topbar.jsx` near the existing right-side controls:

```jsx
<a
  href="https://auth.devpanl.dev/_oauth/logout"
  className="text-xs text-muted-foreground hover:text-foreground"
  title="Sign out of devpanl.dev"
>
  Logout
</a>
```

(Match the existing className conventions in the file — peek at neighboring buttons/links for the right utility classes.)

- [ ] **Step 3: Rebuild and visually confirm in the dev server**

Run: `npm run build:dashboard` (or your dashboard build command).

Then start the server and open `http://localhost:3030/dashboard/` in a browser:

```bash
TRUST_FORWARDED_USER=true ADMIN_API_KEY=devkey node bin/dev-panel.js serve
```

(Set `X-Forwarded-User` via a browser extension like ModHeader if you want `/api/projects` to load locally, otherwise the projects list will be empty but the topbar still renders.)

Expected: "Logout" link visible in the topbar.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/components/topbar.jsx dist/dashboard
git commit -m "feat(dashboard): logout link to traefik-forward-auth"
```

---

## Task 7: Drop unused dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Confirm nothing imports them**

```bash
grep -rn "from 'lucia'\|from '@lucia-auth\|from 'cookie-parser'\|require('lucia')\|require('@lucia-auth\|require('cookie-parser')" src/ tests/ bin/ 2>&1 | grep -v 'node_modules'
```

Expected: no hits. If any hit, do not remove the corresponding package — investigate first.

- [ ] **Step 2: Uninstall**

```bash
npm uninstall lucia @lucia-auth/adapter-sqlite cookie-parser
```

- [ ] **Step 3: Verify package.json is clean**

```bash
grep -E "lucia|@lucia-auth|cookie-parser" package.json
```

Expected: no hits.

- [ ] **Step 4: Smoke test the server boots**

```bash
node -e "import('./src/server/index.js').then(m => { const { app } = m.createServer('./.tmp-storage'); console.log('boot ok'); })" && rm -rf .tmp-storage
```

Expected: `boot ok`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): drop lucia + cookie-parser — OTP path removed"
```

---

## Task 8: Render the allowlist file → env at deploy time

**Files:**
- Create: `infra/scripts/render-whitelist.sh`
- Create or edit: `infra/config/oauth2-proxy-emails.txt`

- [ ] **Step 1: Seed the allowlist file**

Check if it exists:

```bash
ls -l infra/config/oauth2-proxy-emails.txt
```

If absent, create it with at least Franck's email. If present, ensure Franck's email is in it. Example:

```
# Allowlist for traefik-forward-auth (oauth-google@docker middleware).
# One email per line. `#` starts a comment. Adding an email + `git push`
# refreshes the oauth2-proxy container in CI; no devpanel restart needed.
franckbirba@gmail.com
```

- [ ] **Step 2: Write the render script**

Create `infra/scripts/render-whitelist.sh`:

```bash
#!/usr/bin/env bash
# Read infra/config/oauth2-proxy-emails.txt → write a comma-separated WHITELIST
# line into the env file consumed by the oauth2-proxy compose service. Run on
# the VPS by .github/workflows/deploy.yml before `docker compose up -d
# --no-deps oauth2-proxy`.
#
# The output file is not committed (gitignored); it is regenerated on every
# deploy so the source of truth stays the .txt file.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO_ROOT/infra/config/oauth2-proxy-emails.txt"
OUT="$REPO_ROOT/.env.oauth2-proxy"

if [ ! -f "$SRC" ]; then
  echo "render-whitelist: missing $SRC" >&2
  exit 1
fi

# Strip comments + blanks, trim, join with commas. Empty result is an error
# — an empty allowlist would lock everyone out, including Franck.
emails=$(grep -vE '^\s*(#|$)' "$SRC" | awk '{$1=$1; print}' | paste -sd, -)
if [ -z "$emails" ]; then
  echo "render-whitelist: $SRC produced an empty allowlist — aborting" >&2
  exit 1
fi

cat > "$OUT" <<EOF
# Generated by infra/scripts/render-whitelist.sh — DO NOT EDIT BY HAND.
# Source: infra/config/oauth2-proxy-emails.txt
WHITELIST=$emails
EOF

echo "render-whitelist: wrote $OUT ($(echo "$emails" | tr ',' '\n' | wc -l | tr -d ' ') addresses)"
```

- [ ] **Step 3: Make it executable**

```bash
chmod +x infra/scripts/render-whitelist.sh
```

- [ ] **Step 4: Add the generated file to gitignore**

Edit `.gitignore` and append (if not already present):

```
.env.oauth2-proxy
```

- [ ] **Step 5: Smoke test locally**

```bash
infra/scripts/render-whitelist.sh
cat .env.oauth2-proxy
rm .env.oauth2-proxy
```

Expected: a `WHITELIST=franckbirba@gmail.com` line, script prints `wrote .env.oauth2-proxy (1 addresses)`.

- [ ] **Step 6: Commit**

```bash
git add infra/scripts/render-whitelist.sh infra/config/oauth2-proxy-emails.txt .gitignore
git commit -m "feat(infra): render-whitelist.sh — allowlist file is the source of truth"
```

---

## Task 9: Wire the rendered env file into oauth2-proxy

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Switch oauth2-proxy from inline WHITELIST to env_file**

Edit `docker-compose.yml`. Find the `oauth2-proxy` service block (around line 63). Within `environment:`, remove the line:

```yaml
      WHITELIST: franckbirba@gmail.com
```

Then add an `env_file:` block immediately after `environment:` (so `WHITELIST` arrives via the rendered `.env.oauth2-proxy`):

```yaml
    env_file:
      - path: .env.oauth2-proxy
        required: true
```

(Compose v2.20+ supports `path:` / `required:`. The project already uses this syntax for `devpanel`'s env files, so the runtime supports it.)

- [ ] **Step 2: Verify the rest of the oauth2-proxy block is unchanged**

The Google client id/secret, `AUTH_HOST`, `COOKIE_DOMAIN`, `LIFETIME`, the Traefik labels — all stay exactly as today.

- [ ] **Step 3: Validate compose syntax**

```bash
docker compose --profile core config > /dev/null
```

Expected: no output (success). If `docker compose` is not installed locally, skip and rely on CI.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(infra): oauth2-proxy reads WHITELIST from rendered env file"
```

---

## Task 10: Split the devpanl.dev Traefik router

**Files:**
- Modify: `docker-compose.yml`

This is the heart of the migration. Today the `devpanel` service has one router that catches every request to `Host(devpanl.dev)`. After: two routers — M2M (no oauth) and SPA (oauth).

- [ ] **Step 1: Replace the devpanel router labels**

Edit `docker-compose.yml`. Find the `devpanel` service's `labels:` block (around line 152) and replace the existing 5 router/service labels:

```yaml
      - "traefik.enable=true"
      - "traefik.http.routers.devpanel.rule=Host(`devpanl.dev`)"
      - "traefik.http.routers.devpanel.entrypoints=websecure"
      - "traefik.http.routers.devpanel.tls=true"
      - "traefik.http.routers.devpanel.tls.certresolver=letsencrypt"
      - "traefik.http.services.devpanel.loadbalancer.server.port=3030"
```

With:

```yaml
      - "traefik.enable=true"
      # Single backend service shared by both routers.
      - "traefik.http.services.devpanel.loadbalancer.server.port=3030"

      # ── M2M router: /api/*, /widget.js, /health — NO oauth.
      # Used by the standalone widget (cross-origin <script>), the agents-
      # node worker (X-API-Key / X-Admin-Key), and uptime-kuma probes.
      # Higher priority so it wins over the catch-all SPA router below.
      - "traefik.http.routers.devpanel-api.rule=Host(`devpanl.dev`) && (PathPrefix(`/api`) || Path(`/widget.js`) || PathPrefix(`/health`))"
      - "traefik.http.routers.devpanel-api.entrypoints=websecure"
      - "traefik.http.routers.devpanel-api.tls=true"
      - "traefik.http.routers.devpanel-api.tls.certresolver=letsencrypt"
      - "traefik.http.routers.devpanel-api.service=devpanel"
      - "traefik.http.routers.devpanel-api.priority=200"

      # ── SPA router: everything else (/, /dashboard/*, static assets).
      # Gated by oauth-google@docker — Traefik bounces unauthenticated
      # browsers through auth.devpanl.dev → Google → back with cookie.
      - "traefik.http.routers.devpanel-spa.rule=Host(`devpanl.dev`)"
      - "traefik.http.routers.devpanel-spa.entrypoints=websecure"
      - "traefik.http.routers.devpanel-spa.tls=true"
      - "traefik.http.routers.devpanel-spa.tls.certresolver=letsencrypt"
      - "traefik.http.routers.devpanel-spa.service=devpanel"
      - "traefik.http.routers.devpanel-spa.middlewares=oauth-google@docker"
      - "traefik.http.routers.devpanel-spa.priority=100"
```

- [ ] **Step 2: Add `TRUST_FORWARDED_USER` to the devpanel service env**

In the same `devpanel` service block, inside `environment:`, add:

```yaml
      TRUST_FORWARDED_USER: "true"
```

This activates the new middleware in production. Local dev (no docker-compose) leaves it unset and gets 401 on `/api/projects` unless the dev sets it manually.

- [ ] **Step 3: Validate compose syntax**

```bash
docker compose --profile core config > /dev/null
```

Expected: no output.

- [ ] **Step 4: Visually inspect the rendered config (sanity)**

```bash
docker compose --profile core config | grep -A 30 'devpanel:' | head -60
```

Expected: both routers visible, TRUST_FORWARDED_USER=true present.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(infra): split devpanl.dev Traefik router — M2M + oauth SPA"
```

---

## Task 11: Wire the deploy workflow to render allowlist + refresh oauth2-proxy

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Add allowlist render + oauth2-proxy refresh before the devpanel step**

Edit `.github/workflows/deploy.yml`. Find the SSH script section (around line 95, just before `docker compose pull devpanel`). Insert between the existing `bash infra/init.sh production` line and the `docker compose pull devpanel` line:

```bash
            # Render allowlist from emails.txt, then refresh oauth2-proxy so
            # any newly-added invitee is allowed in. Skipping is safe: if the
            # file hasn't changed, oauth2-proxy will be a no-op restart.
            bash infra/scripts/render-whitelist.sh
            docker compose up -d --no-deps oauth2-proxy

```

(Indent matches the surrounding `script:` block — 12 spaces of leading whitespace based on the existing `cd ~/dev-panel` line.)

- [ ] **Step 2: Verify the file lints (yaml syntax)**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))" && echo OK
```

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci(deploy): render allowlist + refresh oauth2-proxy before devpanel"
```

---

## Task 12: Update Shelly's persona + infra docs

**Files:**
- Modify: `.agents/shelly/SOUL.md`
- Modify: `infra/INDEX.md` (if it exists; create a brief note otherwise)

- [ ] **Step 1: Remove the OTP section from SOUL.md**

Edit `.agents/shelly/SOUL.md`. Find and delete the entire section that starts with:

```
## Auth dashboard — messages [auth]
```

…through the end of that section (up to the next `##` heading). The OTP flow no longer exists, so neither does the [auth] message protocol Shelly was supposed to react to.

- [ ] **Step 2: Add a header-spoofing note to infra docs**

Check if `infra/INDEX.md` exists:

```bash
ls infra/INDEX.md 2>/dev/null && echo present || echo missing
```

If present, append a section near the existing oauth/Traefik notes:

```markdown
## devpanl.dev SSO — header-spoofing assumption

The devpanel-api container trusts Traefik's `X-Forwarded-User` header for SPA
bootstrap (`/api/projects`, `/api/projects/summary`). This is safe ONLY as long
as:

1. The container does not bind a host port (it doesn't — only `traefik` exposes
   80/443). All inbound traffic flows through Traefik on `devpanel_net`.
2. Traefik strips any inbound `X-Forwarded-User` from the client before
   `traefik-forward-auth` injects its own (default thomseddon behavior).
3. `TRUST_FORWARDED_USER` is unset everywhere except the production
   `devpanel` compose service. Local dev defaults to off (curl directly
   against `localhost:3030/api/projects` should 401).
```

If `infra/INDEX.md` is missing, skip (don't create it just for this).

- [ ] **Step 3: Deploy Shelly's updated soul**

The SOUL.md is loaded into Shelly via `@.agents/shelly/SOUL.md` in CLAUDE.md. Push will pick it up on the next Shelly restart cycle (4am Europe/Paris) — no manual action needed unless you want it sooner. If sooner:

```bash
ssh hetzner-vps 'systemctl restart shelly.service'
```

(Run only if you want the change live before the nightly restart. Otherwise skip.)

- [ ] **Step 4: Commit**

```bash
git add .agents/shelly/SOUL.md
[ -f infra/INDEX.md ] && git add infra/INDEX.md
git commit -m "docs(shelly,infra): drop [auth] OTP protocol; document SSO header trust"
```

---

## Task 13: Pre-deploy verification (don't push yet)

This is a checkpoint. Do not skip — pushing a half-broken auth migration locks Franck out of the dashboard.

- [ ] **Step 1: Re-run the full unit test suite**

```bash
npm test 2>&1 | tail -30
```

Expected: all green. Known flaky test `tests/worker/bootstrap-project.test.js` may timeout in the full suite (per memory `flaky_bootstrap_test.md`); ignore it if it's the only failure.

- [ ] **Step 2: Boot the production-shaped server locally**

```bash
TRUST_FORWARDED_USER=true \
ADMIN_API_KEY=devkey \
NODE_ENV=production \
ALLOWED_ORIGINS=https://devpanl.dev \
node bin/dev-panel.js serve
```

In another shell, exercise both routers' worth of paths (locally there's no Traefik so we're testing the Express side):

```bash
# Public widget — must be reachable without auth.
curl -s -o /dev/null -w "widget.js: %{http_code}\n" http://localhost:3030/widget.js

# Project API — reachable with X-API-Key (use any project key from your local db, or skip if no projects exist).
# /api/health stays open:
curl -s -o /dev/null -w "/api/health: %{http_code}\n" http://localhost:3030/api/health

# /api/projects without forwarded-user header:
curl -s -o /dev/null -w "/api/projects no-header: %{http_code}\n" http://localhost:3030/api/projects

# /api/projects with forwarded-user header:
curl -s -o /dev/null -w "/api/projects with-header: %{http_code}\n" \
  -H "X-Forwarded-User: franckbirba@gmail.com" http://localhost:3030/api/projects

# /api/projects with admin key:
curl -s -o /dev/null -w "/api/projects with-admin: %{http_code}\n" \
  -H "X-Admin-Key: devkey" http://localhost:3030/api/projects

# /auth/* must be GONE (404).
curl -s -o /dev/null -w "/auth/me: %{http_code}\n" http://localhost:3030/auth/me
```

Expected:
- `widget.js: 200`
- `/api/health: 200`
- `/api/projects no-header: 401`
- `/api/projects with-header: 200`
- `/api/projects with-admin: 200`
- `/auth/me: 404`

If any line deviates, fix before continuing. Stop the server with Ctrl-C.

- [ ] **Step 3: Confirm the Lucia tables are still in master sqlite (rollback safety)**

```bash
sqlite3 storage/projects.db ".tables" 2>/dev/null | tr ' ' '\n' | grep -E '^(user|session)$' || echo "no Lucia tables (fresh DB)"
```

Expected: either `user\nsession` (kept for rollback) or `no Lucia tables (fresh DB)`. The plan does NOT drop these tables — a follow-up does, after a week of stability. If you see them, that's the intended state.

- [ ] **Step 4: No commit needed; proceed to deploy.**

---

## Task 14: Deploy and smoke test in production

- [ ] **Step 1: Push to main**

```bash
git push origin main
```

Watch the GitHub Actions run: `gh run watch` (or the web UI).

Expected: `build-and-push` and `deploy-core` both green. The `sync-stories` jobs are unrelated and may run in parallel.

- [ ] **Step 2: Confirm both containers refreshed on the VPS**

```bash
ssh deploy@77.42.46.87 'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" | grep -E "devpanel|oauth2"'
```

Expected: both `devpanel-api` and `devpanel-oauth2-proxy` show "Up <less than 5 min>".

- [ ] **Step 3: Verify the rendered allowlist on the VPS**

```bash
ssh deploy@77.42.46.87 'cat ~/dev-panel/.env.oauth2-proxy'
```

Expected: `WHITELIST=franckbirba@gmail.com` (or whatever's in your emails.txt).

- [ ] **Step 4: Browser smoke — incognito**

Open an incognito window and visit `https://devpanl.dev/dashboard/today`.

Expected:
1. 307 redirect to `https://accounts.google.com/...`
2. After Google sign-in, redirect back to `devpanl.dev/dashboard/today`
3. Dashboard loads, projects appear in the ribbon, captures load.

If the dashboard loads but is empty, open devtools network: `/api/projects` should return 200. If it returns 401, `TRUST_FORWARDED_USER` likely didn't propagate — check `docker exec devpanel-api env | grep TRUST_FORWARDED_USER`.

- [ ] **Step 5: Browser smoke — widget on staff site**

Open any staff site that embeds `/widget.js` (e.g. `https://edms.epitools.bj`). Trigger a capture from the widget.

Expected: capture POSTs successfully. In the dashboard, the new capture appears in the inbox.

- [ ] **Step 6: Worker smoke**

Check the agents-host worker is still polling Redis and reaching the API:

```bash
ssh hetzner-vps 'journalctl -u devpanel-worker -n 30 --no-pager'
```

Expected: no `401` or `403` errors in the recent log. The worker uses `X-API-Key` against `/api/*` which is on the M2M router.

- [ ] **Step 7: Logout smoke**

In the dashboard, click the new "Logout" link (top bar). Expected: redirects to `auth.devpanl.dev` with the proxy's logout confirmation. Re-visiting `https://devpanl.dev/dashboard/today` must trigger the Google flow again.

- [ ] **Step 8: Final commit (if any post-deploy fixes needed)**

If any of steps 4–7 surfaced an issue and you patched it, commit and push the fix. Otherwise: nothing to commit.

---

## Task 15: Invite the first additional user (validation)

- [ ] **Step 1: Add an email to the allowlist**

Edit `infra/config/oauth2-proxy-emails.txt`, add the invitee's gmail on a new line:

```
franckbirba@gmail.com
invited.collaborator@gmail.com
```

- [ ] **Step 2: Push**

```bash
git add infra/config/oauth2-proxy-emails.txt
git commit -m "chore(allowlist): invite invited.collaborator@gmail.com"
git push origin main
```

- [ ] **Step 3: Wait for CI**

The deploy job will run `render-whitelist.sh` and refresh oauth2-proxy. devpanel itself does not need to restart — that's the design.

- [ ] **Step 4: Have the invitee sign in**

They visit `https://devpanl.dev/dashboard/today`, sign in with Google. They see the dashboard with the same projects Franck sees (no per-user data isolation — that's a follow-up spec).

- [ ] **Step 5: Confirm a removal works too (optional dry-run)**

To remove the invitee:

```bash
# Edit the file, delete their line, push.
git add infra/config/oauth2-proxy-emails.txt
git commit -m "chore(allowlist): remove invited.collaborator@gmail.com"
git push origin main
```

After CI, the invitee's next request returns 401 from traefik-forward-auth. (Their Google session is unaffected — just no longer allowed through devpanl's gate.)

---

## Self-review notes (post-write)

**Spec coverage check:**
- ✅ Routing split into M2M + SPA — Task 10
- ✅ Allowlist file as source of truth — Tasks 8 + 9 + 11
- ✅ Server-side cleanup (Lucia, /auth, auth_deny) — Tasks 3 + 4 + 7
- ✅ `requireForwardedUser` middleware — Task 1
- ✅ `/api/projects` re-gating — Task 2
- ✅ Dashboard SPA cleanup (LoginView, useAuth, hydration) — Task 5
- ✅ Logout link — Task 6
- ✅ Telegram OTP cleanup in SOUL.md — Task 12
- ✅ Header-spoofing mitigation documented — Task 12

**Placeholder scan:** No "TBD", no "implement later". Each step has runnable code or commands.

**Type / name consistency:** `requireForwardedUser` used in Tasks 1, 2, 3 — same signature throughout. `authenticateSpaBootstrap` defined in Task 2 and not referenced elsewhere. `TRUST_FORWARDED_USER` env var name consistent across Tasks 1, 10, 13. `oauth-google@docker` middleware name matches the existing one in compose (verified against current `docker-compose.yml`).

**One judgment call worth flagging:** Task 2 introduces `authenticateSpaBootstrap` (admin-key-or-forwarded-user) inline rather than as a separate file. If the codebase grows more SSO-gated routes, promoting this to its own middleware file is the right move — but for two routes today, inline is cheaper and easier to read.
