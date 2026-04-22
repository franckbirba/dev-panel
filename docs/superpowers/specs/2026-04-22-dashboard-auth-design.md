# Dashboard auth — design

**Date:** 2026-04-22
**Status:** approved (pending implementation plan)
**Owner:** Franck

## Problem

The dashboard currently authenticates the human user via two API keys typed manually into the browser and stored in `localStorage`:

- **Per-project keys** (`projects.api_key`) for scoped access
- **Admin key** (`ADMIN_API_KEY` env var) for admin endpoints

Friction: each new browser, new device, or cleared `localStorage` = re-typing both keys. There is no session, no cookie, no identity. The user describes this as "super mal foutu, rien n'est stocké côté serveur".

## Goal

Replace the human-facing key prompt with a frictionless 2FA-like login flow over Telegram (which the user is always connected to via Shelly), backed by server-side sessions with HttpOnly cookies. Keep machine-to-machine API keys unchanged for widgets, Shelly, the worker, and any future service caller.

## Non-goals

- Multi-user support, account management, invitations, roles. There is one human user (Franck). If that ever changes, the session table can grow a `user_id` column without breaking the flow.
- OAuth, password login, magic email links. Telegram via Shelly is the chosen channel.
- Refactoring how M2M auth works. `X-API-Key` for projects and `X-Admin-Key` for server scripts continue exactly as today.

## High-level flow

```
┌─────────────────┐                         ┌─────────────────┐
│  Dashboard      │ 1. POST /auth/start    │  devpanel-api   │
│  (browser)      │ ──────────────────────> │                 │
│                 │ <────────────────────── │                 │
│  shows code     │ 2. { code, ttl }       │                 │
│  "4 8 2 9 1 7"  │                         │                 │
└─────────────────┘                         └────────┬────────┘
                                                     │ 3. notifyShelly([auth] msg)
                                                     ▼
┌─────────────────┐                         ┌─────────────────┐
│  Franck on     │ 4. types "482917"       │  Shelly         │
│  Telegram      │ ──────────────────────> │  (tmux Claude)  │
└─────────────────┘                         └────────┬────────┘
                                                     │ 5. MCP auth_verify
                                                     │   → POST /auth/verify
                                                     │     X-Admin-Key
                                                     ▼
┌─────────────────┐                         ┌─────────────────┐
│  Dashboard      │ 6. polls /auth/check    │  devpanel-api   │
│  (browser)      │ <────────────────────── │  → Set-Cookie   │
└─────────────────┘  7. { ok, redirect }   └─────────────────┘
```

1. Browser hits dashboard with no session → 401 → renders `<LoginView>`.
2. `<LoginView>` calls `POST /auth/start` with `{user_agent, client_hint}`. Server creates a `pending` challenge with a 6-digit code, 5-minute TTL, returns `{challenge_id, code, ttl}`.
3. Server pushes a `[auth]` Telegram message via `notifyShelly()`: "Login dashboard depuis Chrome / Mac à 03:42 UTC. Code attendu: 4 8 2 9 1 7. Expire dans 5 min."
4. Franck replies in Telegram with the 6 digits (tolerant parser: bare digits, "code 482917", "ok 482917" all accepted).
5. Shelly extracts the code, calls MCP tool `auth_verify({code, telegram_user_id: 5663177530})`. Tool wraps `POST /auth/verify` with `X-Admin-Key`. Server validates: code exists, not expired, not consumed, `telegram_user_id == AUTHORIZED_TELEGRAM_USER_ID`. Marks challenge `verified`, creates a `sessions` row, links `challenge.session_id`.
6. Browser polls `GET /auth/check?challenge_id=ch_xyz` every 2s (max 150 polls = 5min). When server sees `verified` + linked session, it sets `Set-Cookie: devpanl_session=<session.id>; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000; Path=/` and returns `{ok: true}`.
7. Browser does `window.location.reload()`. Next request carries the cookie. Middleware validates session, attaches `req.user`, request proceeds.

## Architecture

### New module: `src/server/auth.js`

Pure functions over the master DB:

- `createChallenge({user_agent, client_hint, ip}) → {challenge_id, code, ttl}` — generates 6-digit code (cryptographic random, not `Math.random`), inserts `pending` row, returns details.
- `getChallengeByCode(code) → row | null` — used by `/auth/verify`.
- `markVerified(challenge_id, session_id) → bool` — atomic transition `pending → verified`, fails if not pending.
- `markConsumed(challenge_id) → bool` — atomic transition `verified → consumed`, called by `/auth/check` after handing the cookie to the browser.
- `markDenied(challenge_id) → bool` — `pending → denied`, used by `auth_deny`.
- `createSession({user_agent, client_hint, ip}) → {id, expires_at}` — generates 64-hex random, inserts row.
- `validateSession(session_id) → row | null` — returns row if exists, not revoked, not expired.
- `bumpSession(session_id) → void` — sets `last_seen_at = now`, `expires_at = now + 30d`. Called by middleware on every authenticated request (sliding window).
- `revokeSession(session_id) → void` — sets `revoked_at`.

All cryptographic randomness via `node:crypto` `randomBytes`.

### New endpoints in `src/server/routes.js`

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| `POST` | `/auth/start` | none (rate-limited) | `{user_agent, client_hint}` | `{challenge_id, code, ttl, notification_sent}` |
| `POST` | `/auth/verify` | `X-Admin-Key` | `{code, telegram_user_id}` | `{ok, reason?, challenge_id?, session_created?}` |
| `POST` | `/auth/deny` | `X-Admin-Key` | `{code}` | `{ok, reason?}` |
| `GET` | `/auth/check?challenge_id=...` | none | – | `{state, ok?}` + sets cookie when state=verified |
| `POST` | `/auth/logout` | cookie session | – | `{ok}` + clears cookie |

`/auth/start` rate limit: max 5 active (pending) challenges per IP. Reject with 429 beyond that.
`/auth/verify` rate limit: max 10 attempts per IP per minute (in addition to the global limiter).

### New auth middleware: `requireAuth`

Replaces piecemeal `authenticateProject` / `authenticateAdmin` calls on routes that should accept either humans or services. Chain:

```js
function requireAuth(req, res, next) {
  // 1. Try cookie session
  const sid = req.cookies?.devpanl_session;
  if (sid) {
    const session = validateSession(sid);
    if (session) {
      bumpSession(sid);
      req.user = { type: 'session', session_id: sid };
      return next();
    }
  }
  // 2. Try project API key
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey) {
    const project = getProjectByApiKey(apiKey);
    if (project) {
      req.project = project;
      req.user = { type: 'project_key', project_id: project.id };
      return next();
    }
  }
  // 3. Try admin key
  const adminKey = req.headers['x-admin-key'];
  if (adminKey && process.env.ADMIN_API_KEY) {
    const a = Buffer.from(adminKey);
    const b = Buffer.from(process.env.ADMIN_API_KEY);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      req.user = { type: 'admin_key' };
      return next();
    }
  }
  return res.status(401).json({ error: 'Authentication required' });
}
```

A session-authenticated request implicitly has admin scope (single user, owns everything). Endpoints that previously checked `authenticateAdmin` strictly accept either `req.user.type === 'session'` or `req.user.type === 'admin_key'`.

### MCP tools `auth_verify` and `auth_deny`

Added to `src/mcp/server.js`. Both wrap their respective HTTP endpoint with `X-Admin-Key`. Schema:

```js
server.tool('auth_verify',
  'Validate a 6-digit dashboard login code received from Franck in Telegram',
  { code: z.string().regex(/^\d{6}$/), telegram_user_id: z.number() },
  async ({ code, telegram_user_id }) => { /* fetch /auth/verify */ }
);

server.tool('auth_deny',
  'Reject a dashboard login attempt that Franck did not initiate',
  { code: z.string().regex(/^\d{6}$/) },
  async ({ code }) => { /* fetch /auth/deny */ }
);
```

`API_BASE` is added to the `devpanel-mcp` env block in `infra/agents-mcp.json.template`. Default value: `https://devpanl.dev`.

### Shelly SOUL update

New section in `.agents/shelly/SOUL.md`:

```md
### Auth dashboard — messages [auth]

Quand un message taggé `[auth]` arrive (push de l'API quand Franck tente un login dashboard):
- Le message contient un code à 6 chiffres et un descripteur du browser/OS.
- Ne fais rien tant que Franck n'a pas répondu.
- Quand Franck répond avec **6 chiffres** (avec ou sans espaces, avec ou sans préfixe "code"/"ok"), extrait le code et appelle `auth_verify({code, telegram_user_id: <son id>})`.
- Si la réponse est `{ok: true}`, dis "✅ Loggé." (court, pas de cérémonie).
- Si `{ok: false, reason: "expired"}`: "Le code a expiré, relance un login depuis le dashboard."
- Si `{ok: false, reason: "unknown_code"}`: "Code pas reconnu, t'es sûr du chiffre?"
- Si Franck répond "non" / "pas moi" / "kill" en réponse à un [auth]: appelle `auth_deny({code})` avec le dernier code en flight, dis "OK, login rejeté." et inclus l'IP du message [auth] original.
```

### Dashboard frontend

- New view `src/dashboard/views/login-view.jsx`:
  - Calls `POST /auth/start` with `{user_agent: navigator.userAgent, client_hint: detectClient()}`.
  - Displays the 6-digit code in large monospace, with a 5-minute countdown.
  - Polls `GET /auth/check?challenge_id=...` every 2s.
  - On `{ok: true}`: `window.location.reload()`.
  - "Renvoyer le code" button if expired.
- `src/dashboard/app.jsx`:
  - On mount, attempt `GET /api/today` with no headers.
  - On 401, mount `<LoginView>`.
  - On success, mount the existing dashboard.
- Removes `localStorage.getItem('devpanel_admin_key')` UI from the existing settings/welcome screen — admin scope is now implicit to a logged-in session.
- Keeps `devpanel_projects` localStorage map (still needed for the per-project tabs and widget keys, just no longer used to authenticate the human).

## Database schema

Both tables go in `projects.db` (master DB), since auth is cross-project.

```sql
CREATE TABLE auth_challenges (
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending','verified','consumed','expired','denied')),
  user_agent      TEXT,
  client_hint     TEXT,
  ip              TEXT,
  notification_sent INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  verified_at     INTEGER,
  consumed_at     INTEGER,
  session_id      TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE INDEX idx_auth_challenges_code_state ON auth_challenges(code, state);
CREATE INDEX idx_auth_challenges_expires ON auth_challenges(expires_at) WHERE state = 'pending';

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  user_agent      TEXT,
  client_hint     TEXT,
  ip              TEXT,
  revoked_at      INTEGER
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at) WHERE revoked_at IS NULL;
```

Garbage collection: `setInterval` every 10min in `src/server/index.js`:
```js
db.exec(`
  DELETE FROM auth_challenges WHERE expires_at < ${Date.now() - 3600000};
  DELETE FROM sessions WHERE expires_at < ${Date.now() - 7*86400000};
`);
```

## TTL & timing

| Item | Value | Notes |
|---|---|---|
| Challenge TTL | 5 min | Server-side check; UI countdown matches. |
| Session TTL | 30 days sliding | Bumped to `now + 30d` on every authenticated request. |
| Polling cadence | 2s | Max 150 polls per challenge. |
| GC interval | 10 min | Deletes expired/consumed challenges (>1h old) and revoked/expired sessions (>7d old). |

## Security

- 6-digit codes generated via `crypto.randomInt(0, 1_000_000)`, formatted `padStart(6, '0')`. Not predictable.
- Session IDs: `crypto.randomBytes(32).toString('hex')` = 64 hex chars, 256 bits of entropy. Opaque tokens, no JWT.
- Cookie: `HttpOnly` (no JS access, blunts XSS), `Secure` (HTTPS only — already enforced via Traefik), `SameSite=Lax` (blocks cross-site CSRF for state-changing requests), `Path=/`, `Max-Age=2592000`.
- Code comparison via `crypto.timingSafeEqual` to prevent timing side-channels.
- Mandatory check `telegram_user_id === parseInt(process.env.AUTHORIZED_TELEGRAM_USER_ID)` on `/auth/verify`. Even if a code leaks or Shelly is compromised, an unauthorized user cannot complete the flow.
- Rate limits: 5 active challenges per IP, 10 verify attempts per IP per minute, on top of the existing global 100 req/min.
- Logout endpoint sets `revoked_at` and clears the cookie. Useful when "I lost my laptop" happens — for now, the rotation procedure is "revoke all sessions in the DB by hand" or "invalidate `AUTHORIZED_TELEGRAM_USER_ID`". A device-list UI is out of scope for v1 (single user).

## Coexistence with existing API keys

Per-project keys (`X-API-Key`) and admin key (`X-Admin-Key`) continue to work unchanged. The new `requireAuth` middleware is a chain that tries cookie session first, then falls back to keys. Endpoints opting into the new middleware accept all three. Endpoints that should remain key-only (M2M only, e.g. widget POST `/api/captures` from external apps) keep their current `authenticateProject` middleware.

This means:
- The widget in Zeno/EDMS keeps using `X-API-Key`. No code change.
- Shelly's `notifyJob()` push notifications keep using `X-Admin-Key`. No code change.
- Worker keeps using whatever it uses today. No code change.
- Only the dashboard browser flow changes.

## Environment variables (new)

- `AUTHORIZED_TELEGRAM_USER_ID=5663177530` — single source of truth for who can validate logins. Goes in `.env.production` on services VPS, mirrored into the agents-host `.env.agent` for the MCP to read (so it can echo the value when a denied attempt happens).
- `API_BASE=https://devpanl.dev` — added to the `devpanel-mcp` env in `infra/agents-mcp.json.template` so `auth_verify` knows where to POST.

## Implementation sequence

5 stages, each independently deployable. After each, the system is in a coherent state. Stopping after stage 3 still gives a working backward-compatible system (no human-facing change yet).

**Stage 1 — Schema + auth core module.** Tables + `src/server/auth.js`. Unit tests. No HTTP, no UI. Backward-safe.

**Stage 2 — HTTP endpoints `/auth/{start,verify,check,logout}`.** Routes wired. Manual curl testing with `X-Admin-Key`. No frontend change. Backward-safe.

**Stage 3 — `requireAuth` middleware + integration on dashboard routes.** Cookie session takes priority but API keys still work. Dashboard continues to function with its existing localStorage keys. Backward-safe.

**Stage 4 — MCP tools + Shelly SOUL update + agents-host deploy.** Adds `auth_verify` / `auth_deny` to `src/mcp/server.js`, adds `API_BASE` to the MCP env template, updates `.agents/shelly/SOUL.md`. Deploy via `bash scripts/deploy-agents.sh` + `systemctl restart shelly.service`. Test by manually triggering a challenge via curl, replying in Telegram, verifying the cookie is set. Backward-safe (no UI change yet).

**Stage 5 — Dashboard React migration.** New `<LoginView>`, `app.jsx` change, removal of admin-key UI. End-to-end test in incognito browser. After this stage, the human flow is the new one. The legacy localStorage admin key entry is deleted from the UI but cookie sessions take over seamlessly for already-logged-in browsers.

## End-to-end manual test plan

Run on an incognito browser (worst case: empty localStorage):

1. Open `https://devpanl.dev/dashboard/today` → see `<LoginView>` with 6-digit code and countdown.
2. Verify Shelly pushed `[auth]` message in Telegram with the matching code and a `client_hint` like "Safari on iPhone".
3. Reply `482917` in Telegram → Shelly replies "✅ Loggé."
4. Dashboard reloads automatically, dashboard content visible.
5. Close tab, reopen → no re-login (cookie still valid).
6. Click logout → land back on `<LoginView>`.
7. From a different browser, trigger a login. In Telegram reply "non" → Shelly replies "OK, login rejeté." → that browser sees the challenge denied.
8. M2M smoke: `curl -H "X-API-Key: <project_key>" .../api/captures` still returns 200. No regression.
9. Expiration: trigger a challenge, wait 6 min without replying → dashboard shows "Code expiré, relance un login".
10. Bad code: in Telegram, reply with a wrong code → Shelly says "Code pas reconnu".

## Rollback plan per stage

| Stage | Failure mode | Rollback |
|---|---|---|
| 1 | Schema migration breaks the DB | Restore `projects.db` from backup; revert commit. No public exposure yet. |
| 2 | Endpoints throw 500s | Routes are isolated — revert routes commit. Existing endpoints unaffected. |
| 3 | `requireAuth` middleware misbehaves | Revert middleware integration; routes fall back to old `authenticateProject` / `authenticateAdmin`. Sessions in DB remain — no data loss. |
| 4 | Shelly stuck or MCP error | `git revert` SOUL change, redeploy, `systemctl restart shelly.service`. Endpoints still work via curl + admin key. |
| 5 | LoginView broken | Revert dashboard commit, redeploy. Cookie-logged-in users stay logged in. New users hit the previous (now slightly broken: admin-key UI gone) flow — but stage 4 means they can still curl-login if needed. Optional: temporary `?legacy=1` query flag during the first week. |

## Open question — none

All decisions captured. `AUTHORIZED_TELEGRAM_USER_ID=5663177530` confirmed by the user.

## Next step

Invoke `superpowers:writing-plans` to produce a stage-by-stage implementation plan against this spec.
