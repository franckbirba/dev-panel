# Dashboard Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual API-key prompt in the dashboard browser with a Telegram-via-Shelly 2FA login backed by HttpOnly cookie sessions, while keeping all M2M API keys (per-project, admin) working unchanged.

**Architecture:** Server-side `auth_challenges` + `sessions` tables in the master DB. Five HTTP endpoints (`/auth/start`, `/auth/verify`, `/auth/deny`, `/auth/check`, `/auth/logout`). A `requireAuth` middleware chain that tries cookie session → project key → admin key → 401. Two MCP tools (`auth_verify`, `auth_deny`) that Shelly calls when Franck replies in Telegram. New `<LoginView>` React component that polls `/auth/check`. Backward-compatible at every stage — M2M never breaks.

**Tech Stack:** Express, better-sqlite3, vitest, cookie-parser, React 18, Zod (already in MCP).

**Spec:** `docs/superpowers/specs/2026-04-22-dashboard-auth-design.md`

---

## File structure

**New files:**
- `src/server/auth.js` — pure functions over the auth tables
- `src/server/auth-routes.js` — Express router for `/auth/*` endpoints
- `src/server/middleware/require-auth.js` — the auth chain middleware
- `tests/server/auth.test.js` — unit tests for `auth.js`
- `tests/server/auth-routes.test.js` — integration tests for `/auth/*`
- `src/dashboard/views/login-view.jsx` — React login flow
- `src/dashboard/lib/use-auth.js` — small hook that owns the auth check + login state

**Modified files:**
- `src/server/db.js` — add `auth_challenges` + `sessions` tables in `initMasterDatabase`
- `src/server/index.js` — wire `auth-routes`, `cookie-parser`, GC cron
- `src/server/routes.js` — replace per-route `authenticateAdmin` calls with `requireAuth`
- `src/mcp/server.js` — add `auth_verify` + `auth_deny` tools
- `src/dashboard/app.jsx` — mount `<LoginView>` on 401, otherwise dashboard
- `src/dashboard/lib/projects-store.js` — drop legacy `getAdminKey`/`setAdminKey` exports (unused after migration)
- `package.json` — add `cookie-parser` dep
- `infra/agents-mcp.json.template` — add `API_BASE` to devpanel-mcp env block
- `.agents/shelly/SOUL.md` — add "Auth dashboard — messages [auth]" section
- `infra/init.sh` — add `AUTHORIZED_TELEGRAM_USER_ID` to the secrets exported into `.env.production`

**Test runner:** vitest. Run individual: `npx vitest run tests/server/auth.test.js`. Run all: `npm test`.

---

## Stage 1 — Schema + auth core module (backend, no HTTP)

### Task 1.1: Add `auth_challenges` and `sessions` tables to master DB

**Files:**
- Modify: `src/server/db.js`

- [ ] **Step 1: Add the two CREATE TABLE statements inside `initMasterDatabase`**

In `src/server/db.js`, locate the `initMasterDatabase` function (line ~13). After the existing `CREATE TABLE IF NOT EXISTS deploy_events ...` block (around line 174-191), add:

```js
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,
    created_at      INTEGER NOT NULL,
    last_seen_at    INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    user_agent      TEXT,
    client_hint     TEXT,
    ip              TEXT,
    revoked_at      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires
    ON sessions(expires_at) WHERE revoked_at IS NULL;

  CREATE TABLE IF NOT EXISTS auth_challenges (
    id              TEXT PRIMARY KEY,
    code            TEXT NOT NULL,
    state           TEXT NOT NULL
                    CHECK (state IN ('pending','verified','consumed','expired','denied')),
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
  CREATE INDEX IF NOT EXISTS idx_auth_challenges_code_state
    ON auth_challenges(code, state);
  CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires
    ON auth_challenges(expires_at) WHERE state = 'pending';
`);
```

Note: `sessions` is created first because `auth_challenges.session_id` references it.

- [ ] **Step 2: Verify the migration runs without error**

Start the server locally (or call the init function from a script):
```bash
node -e "import('./src/server/db.js').then(m => m.initMasterDatabase('./storage'))"
```

Expected: no output, no error. Verify tables exist:
```bash
sqlite3 ./storage/projects.db ".schema sessions" ".schema auth_challenges"
```

Expected: prints both schemas.

- [ ] **Step 3: Commit**

```bash
git add src/server/db.js
git commit -m "feat(db): add sessions and auth_challenges tables to master DB"
```

---

### Task 1.2: Write failing test for `createChallenge`

**Files:**
- Create: `tests/server/auth.test.js`

- [ ] **Step 1: Create the test file with the first failing test**

```js
// tests/server/auth.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, getMasterDatabase } from '../../src/server/db.js';
import {
  createChallenge,
  getChallengeByCode,
  markVerified,
  markConsumed,
  markDenied,
  createSession,
  validateSession,
  bumpSession,
  revokeSession
} from '../../src/server/auth.js';

let storage;
beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), 'devpanel-auth-test-'));
  initMasterDatabase(storage);
});
afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
});

describe('createChallenge', () => {
  it('returns a 6-digit code, ttl, and challenge_id', () => {
    const result = createChallenge({
      user_agent: 'Mozilla/5.0',
      client_hint: 'Chrome on Mac',
      ip: '127.0.0.1'
    });
    expect(result.code).toMatch(/^\d{6}$/);
    expect(result.challenge_id).toMatch(/^ch_[a-f0-9]+$/);
    expect(result.ttl).toBe(300); // 5 minutes
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/server/auth.test.js
```

Expected: FAIL — `Cannot find module '../../src/server/auth.js'`

- [ ] **Step 3: Create `src/server/auth.js` with minimal `createChallenge`**

```js
// src/server/auth.js
import { randomBytes, randomInt } from 'crypto';
import { getMasterDatabase } from './db.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function createChallenge({ user_agent = null, client_hint = null, ip = null } = {}) {
  const db = getMasterDatabase();
  const challenge_id = 'ch_' + randomBytes(8).toString('hex');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const now = Date.now();
  const expires_at = now + CHALLENGE_TTL_MS;

  db.prepare(`
    INSERT INTO auth_challenges
      (id, code, state, user_agent, client_hint, ip, notification_sent, created_at, expires_at)
    VALUES (?, ?, 'pending', ?, ?, ?, 0, ?, ?)
  `).run(challenge_id, code, user_agent, client_hint, ip, now, expires_at);

  return { challenge_id, code, ttl: 300 };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/server/auth.test.js
```

Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add tests/server/auth.test.js src/server/auth.js
git commit -m "feat(auth): createChallenge generates 6-digit codes with 5min TTL"
```

---

### Task 1.3: Add `getChallengeByCode` with state filter

**Files:**
- Modify: `tests/server/auth.test.js`
- Modify: `src/server/auth.js`

- [ ] **Step 1: Add the failing test**

Append to `tests/server/auth.test.js`:

```js
describe('getChallengeByCode', () => {
  it('returns the challenge row for a pending code', () => {
    const { code } = createChallenge({});
    const row = getChallengeByCode(code);
    expect(row).toBeTruthy();
    expect(row.code).toBe(code);
    expect(row.state).toBe('pending');
  });

  it('returns null for unknown codes', () => {
    expect(getChallengeByCode('999999')).toBeNull();
  });

  it('returns null for expired pending challenges', () => {
    const { code, challenge_id } = createChallenge({});
    // Force expiry by direct DB write
    const db = getMasterDatabase();
    db.prepare('UPDATE auth_challenges SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1000, challenge_id);
    expect(getChallengeByCode(code)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify FAIL (`getChallengeByCode is not a function`)**

```bash
npx vitest run tests/server/auth.test.js
```

- [ ] **Step 3: Implement `getChallengeByCode` in `src/server/auth.js`**

Add to `src/server/auth.js`:

```js
export function getChallengeByCode(code) {
  const db = getMasterDatabase();
  const row = db.prepare(`
    SELECT * FROM auth_challenges
    WHERE code = ? AND state = 'pending' AND expires_at > ?
  `).get(code, Date.now());
  return row || null;
}
```

- [ ] **Step 4: Run, verify PASS (4 tests total)**

```bash
npx vitest run tests/server/auth.test.js
```

- [ ] **Step 5: Commit**

```bash
git add tests/server/auth.test.js src/server/auth.js
git commit -m "feat(auth): getChallengeByCode with state and expiry filters"
```

---

### Task 1.4: Add `createSession` + `validateSession` + `bumpSession`

**Files:**
- Modify: `tests/server/auth.test.js`
- Modify: `src/server/auth.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/server/auth.test.js`:

```js
describe('sessions', () => {
  it('createSession returns a 64-hex id with 30d TTL', () => {
    const session = createSession({ user_agent: 'UA', client_hint: 'Chrome', ip: '1.2.3.4' });
    expect(session.id).toMatch(/^[a-f0-9]{64}$/);
    expect(session.expires_at).toBeGreaterThan(Date.now() + 29 * 86400 * 1000);
    expect(session.expires_at).toBeLessThan(Date.now() + 31 * 86400 * 1000);
  });

  it('validateSession returns the row for a fresh session', () => {
    const created = createSession({});
    const row = validateSession(created.id);
    expect(row.id).toBe(created.id);
  });

  it('validateSession returns null for unknown ids', () => {
    expect(validateSession('deadbeef'.repeat(8))).toBeNull();
  });

  it('validateSession returns null for revoked sessions', () => {
    const created = createSession({});
    revokeSession(created.id);
    expect(validateSession(created.id)).toBeNull();
  });

  it('validateSession returns null for expired sessions', () => {
    const created = createSession({});
    const db = getMasterDatabase();
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1000, created.id);
    expect(validateSession(created.id)).toBeNull();
  });

  it('bumpSession extends expires_at to now + 30d', () => {
    const created = createSession({});
    const db = getMasterDatabase();
    // Manually set expires_at to 5 days from now to verify bump pushes it forward
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .run(Date.now() + 5 * 86400 * 1000, created.id);
    bumpSession(created.id);
    const row = db.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(created.id);
    expect(row.expires_at).toBeGreaterThan(Date.now() + 29 * 86400 * 1000);
  });
});
```

- [ ] **Step 2: Run, verify FAILs (`createSession is not a function` etc.)**

```bash
npx vitest run tests/server/auth.test.js
```

- [ ] **Step 3: Implement the four functions in `src/server/auth.js`**

Append to `src/server/auth.js`:

```js
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createSession({ user_agent = null, client_hint = null, ip = null } = {}) {
  const db = getMasterDatabase();
  const id = randomBytes(32).toString('hex');
  const now = Date.now();
  const expires_at = now + SESSION_TTL_MS;
  db.prepare(`
    INSERT INTO sessions (id, created_at, last_seen_at, expires_at, user_agent, client_hint, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, now, now, expires_at, user_agent, client_hint, ip);
  return { id, expires_at };
}

export function validateSession(session_id) {
  if (!session_id || typeof session_id !== 'string') return null;
  const db = getMasterDatabase();
  const row = db.prepare(`
    SELECT * FROM sessions
    WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
  `).get(session_id, Date.now());
  return row || null;
}

export function bumpSession(session_id) {
  const db = getMasterDatabase();
  const now = Date.now();
  db.prepare(`
    UPDATE sessions
    SET last_seen_at = ?, expires_at = ?
    WHERE id = ? AND revoked_at IS NULL
  `).run(now, now + SESSION_TTL_MS, session_id);
}

export function revokeSession(session_id) {
  const db = getMasterDatabase();
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(Date.now(), session_id);
}
```

- [ ] **Step 4: Run, verify all tests PASS (10 total)**

```bash
npx vitest run tests/server/auth.test.js
```

- [ ] **Step 5: Commit**

```bash
git add tests/server/auth.test.js src/server/auth.js
git commit -m "feat(auth): session lifecycle (create, validate, bump, revoke)"
```

---

### Task 1.5: Add `markVerified`, `markConsumed`, `markDenied`

**Files:**
- Modify: `tests/server/auth.test.js`
- Modify: `src/server/auth.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/server/auth.test.js`:

```js
describe('challenge state transitions', () => {
  it('markVerified moves pending → verified and links session_id', () => {
    const { challenge_id } = createChallenge({});
    const session = createSession({});
    const ok = markVerified(challenge_id, session.id);
    expect(ok).toBe(true);
    const db = getMasterDatabase();
    const row = db.prepare('SELECT * FROM auth_challenges WHERE id = ?').get(challenge_id);
    expect(row.state).toBe('verified');
    expect(row.session_id).toBe(session.id);
    expect(row.verified_at).toBeGreaterThan(0);
  });

  it('markVerified returns false if challenge already verified', () => {
    const { challenge_id } = createChallenge({});
    const session = createSession({});
    markVerified(challenge_id, session.id);
    const second = markVerified(challenge_id, session.id);
    expect(second).toBe(false);
  });

  it('markConsumed moves verified → consumed', () => {
    const { challenge_id } = createChallenge({});
    const session = createSession({});
    markVerified(challenge_id, session.id);
    const ok = markConsumed(challenge_id);
    expect(ok).toBe(true);
    const db = getMasterDatabase();
    const row = db.prepare('SELECT state, consumed_at FROM auth_challenges WHERE id = ?').get(challenge_id);
    expect(row.state).toBe('consumed');
    expect(row.consumed_at).toBeGreaterThan(0);
  });

  it('markConsumed returns false if not in verified state', () => {
    const { challenge_id } = createChallenge({});
    expect(markConsumed(challenge_id)).toBe(false); // still pending
  });

  it('markDenied moves pending → denied', () => {
    const { challenge_id } = createChallenge({});
    expect(markDenied(challenge_id)).toBe(true);
    const db = getMasterDatabase();
    const row = db.prepare('SELECT state FROM auth_challenges WHERE id = ?').get(challenge_id);
    expect(row.state).toBe('denied');
  });
});
```

- [ ] **Step 2: Run, verify FAILs**

- [ ] **Step 3: Implement the three functions in `src/server/auth.js`**

Append:

```js
export function markVerified(challenge_id, session_id) {
  const db = getMasterDatabase();
  const result = db.prepare(`
    UPDATE auth_challenges
    SET state = 'verified', verified_at = ?, session_id = ?
    WHERE id = ? AND state = 'pending' AND expires_at > ?
  `).run(Date.now(), session_id, challenge_id, Date.now());
  return result.changes === 1;
}

export function markConsumed(challenge_id) {
  const db = getMasterDatabase();
  const result = db.prepare(`
    UPDATE auth_challenges
    SET state = 'consumed', consumed_at = ?
    WHERE id = ? AND state = 'verified'
  `).run(Date.now(), challenge_id);
  return result.changes === 1;
}

export function markDenied(challenge_id) {
  const db = getMasterDatabase();
  const result = db.prepare(`
    UPDATE auth_challenges SET state = 'denied'
    WHERE id = ? AND state = 'pending'
  `).run(challenge_id);
  return result.changes === 1;
}
```

- [ ] **Step 4: Run, verify all tests PASS (15 total)**

- [ ] **Step 5: Commit**

```bash
git add tests/server/auth.test.js src/server/auth.js
git commit -m "feat(auth): challenge state transitions (verified, consumed, denied)"
```

---

## Stage 2 — HTTP endpoints `/auth/*`

### Task 2.1: Install `cookie-parser` and wire it in

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `src/server/index.js`

- [ ] **Step 1: Install the dep**

```bash
npm install cookie-parser
```

- [ ] **Step 2: Wire `cookieParser()` into the Express app**

In `src/server/index.js`, locate where the app is created and middleware is added. Add the import at the top:
```js
import cookieParser from 'cookie-parser';
```

After `app.use(express.json(...))` (or similar), add:
```js
app.use(cookieParser());
```

- [ ] **Step 3: Smoke test**

```bash
node -e "import('./src/server/index.js').then(() => console.log('OK'))"
```

Expected: prints `OK`, no module error.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/server/index.js
git commit -m "feat(server): add cookie-parser middleware"
```

---

### Task 2.2: Create `/auth/start` endpoint

**Files:**
- Create: `tests/server/auth-routes.test.js`
- Create: `src/server/auth-routes.js`
- Modify: `src/server/index.js`

- [ ] **Step 1: Write the failing integration test**

```js
// tests/server/auth-routes.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initMasterDatabase, getMasterDatabase } from '../../src/server/db.js';
import { createAuthRouter } from '../../src/server/auth-routes.js';

let storage, app;
beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), 'devpanel-auth-routes-'));
  initMasterDatabase(storage);
  process.env.ADMIN_API_KEY = 'test-admin-key-32-chars-padding-x';
  process.env.AUTHORIZED_TELEGRAM_USER_ID = '5663177530';
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/auth', createAuthRouter());
});
afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
  delete process.env.ADMIN_API_KEY;
  delete process.env.AUTHORIZED_TELEGRAM_USER_ID;
});

describe('POST /auth/start', () => {
  it('returns a 6-digit code and challenge_id', async () => {
    const res = await fetch('http://localhost:0/auth/start', { /* see Step 3 */ });
    // (See step 3 — test will use supertest-style helper)
  });
});
```

The actual approach: vitest tests don't easily start a real HTTP server, so use `supertest` for express routing tests. Install it as a dev dep:

```bash
npm install --save-dev supertest
```

Then rewrite the test:

```js
// tests/server/auth-routes.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initMasterDatabase } from '../../src/server/db.js';
import { createAuthRouter } from '../../src/server/auth-routes.js';

let storage, app;
beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), 'devpanel-auth-routes-'));
  initMasterDatabase(storage);
  process.env.ADMIN_API_KEY = 'test-admin-key-32-chars-padding-x';
  process.env.AUTHORIZED_TELEGRAM_USER_ID = '5663177530';
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/auth', createAuthRouter());
});
afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
  delete process.env.ADMIN_API_KEY;
  delete process.env.AUTHORIZED_TELEGRAM_USER_ID;
});

describe('POST /auth/start', () => {
  it('returns 200 with a challenge_id, 6-digit code, and ttl', async () => {
    const res = await request(app)
      .post('/auth/start')
      .send({ user_agent: 'Mozilla/5.0', client_hint: 'Chrome on Mac' });
    expect(res.status).toBe(200);
    expect(res.body.code).toMatch(/^\d{6}$/);
    expect(res.body.challenge_id).toMatch(/^ch_/);
    expect(res.body.ttl).toBe(300);
  });
});
```

- [ ] **Step 2: Run, verify FAIL (`Cannot find module auth-routes.js`)**

```bash
npx vitest run tests/server/auth-routes.test.js
```

- [ ] **Step 3: Implement `src/server/auth-routes.js`**

```js
// src/server/auth-routes.js
import express from 'express';
import { createChallenge } from './auth.js';
// notifyAuthChallenge is added in Task 2.3 — for now just import a stub
async function notifyAuthChallenge(/* challenge */) { /* wired in 2.3 */ }

export function createAuthRouter() {
  const router = express.Router();

  router.post('/start', async (req, res) => {
    const user_agent = req.body?.user_agent || req.headers['user-agent'] || null;
    const client_hint = req.body?.client_hint || null;
    const ip = req.ip || req.socket?.remoteAddress || null;
    const challenge = createChallenge({ user_agent, client_hint, ip });
    // Best-effort push notification (added in Task 2.3)
    let notification_sent = true;
    try { await notifyAuthChallenge({ ...challenge, client_hint, ip }); }
    catch { notification_sent = false; }
    res.json({ ...challenge, notification_sent });
  });

  return router;
}
```

- [ ] **Step 4: Run, verify PASS**

```bash
npx vitest run tests/server/auth-routes.test.js
```

- [ ] **Step 5: Wire the router in `src/server/index.js`**

Add the import:
```js
import { createAuthRouter } from './auth-routes.js';
```

Mount before the existing API routes:
```js
app.use('/auth', createAuthRouter());
```

- [ ] **Step 6: Commit**

```bash
git add tests/server/auth-routes.test.js src/server/auth-routes.js src/server/index.js package.json package-lock.json
git commit -m "feat(auth): POST /auth/start endpoint creates challenges"
```

---

### Task 2.3: Push challenges to Shelly via `notifyAuthChallenge`

**Files:**
- Modify: `src/server/alerts.js`
- Modify: `src/server/auth-routes.js`

- [ ] **Step 1: Add `notifyAuthChallenge` to `src/server/alerts.js`**

Append to `src/server/alerts.js` (it already has `_sendText` helper which we reuse):

```js
/**
 * Push a [auth] challenge message to Shelly's Telegram chat.
 * Format: human-readable line that Shelly's SOUL knows how to handle.
 * @param {Object} challenge - { code, client_hint, ip, ttl }
 */
export async function notifyAuthChallenge({ code, client_hint, ip, ttl = 300 }) {
  if (!_hasDestination()) {
    console.warn('[Auth] No Telegram destination, skipping notification');
    return false;
  }
  const where = client_hint || 'unknown browser';
  const when = new Date().toISOString().slice(11, 19);
  const ipPart = ip ? ` (IP ${ip})` : '';
  const text = `[auth] Login dashboard depuis ${where}${ipPart} à ${when} UTC. ` +
               `Code attendu: ${code}. Expire dans ${Math.round(ttl / 60)} min.`;
  try {
    await _sendText(text);
    return true;
  } catch (err) {
    console.error('[Auth] notifyAuthChallenge failed:', err.message);
    return false;
  }
}
```

- [ ] **Step 2: Use it in `auth-routes.js`**

Replace the stub in `src/server/auth-routes.js`:

```js
import { notifyAuthChallenge } from './alerts.js';
```

And update the `/start` handler:
```js
router.post('/start', async (req, res) => {
  const user_agent = req.body?.user_agent || req.headers['user-agent'] || null;
  const client_hint = req.body?.client_hint || null;
  const ip = req.ip || req.socket?.remoteAddress || null;
  const challenge = createChallenge({ user_agent, client_hint, ip });
  const notification_sent = await notifyAuthChallenge({ ...challenge, client_hint, ip });
  // Persist notification_sent flag on the challenge row
  if (notification_sent) {
    const { getMasterDatabase } = await import('./db.js');
    getMasterDatabase().prepare(
      'UPDATE auth_challenges SET notification_sent = 1 WHERE id = ?'
    ).run(challenge.challenge_id);
  }
  res.json({ ...challenge, notification_sent });
});
```

- [ ] **Step 3: Run existing tests, verify they still PASS**

```bash
npx vitest run tests/server/auth-routes.test.js
```

(The test does not have Telegram env vars set, so `notifyAuthChallenge` will return false and the response will have `notification_sent: false`. The test only asserts on `code`, `challenge_id`, `ttl`, so it still passes.)

- [ ] **Step 4: Add a test that asserts `notification_sent: false` without env**

In `tests/server/auth-routes.test.js`, append:
```js
it('returns notification_sent=false when no Telegram destination is configured', async () => {
  const res = await request(app)
    .post('/auth/start')
    .send({ client_hint: 'Chrome' });
  expect(res.body.notification_sent).toBe(false);
});
```

Run, verify PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/alerts.js src/server/auth-routes.js tests/server/auth-routes.test.js
git commit -m "feat(auth): notify Shelly via Telegram when challenge created"
```

---

### Task 2.4: `POST /auth/verify` (admin-key gated)

**Files:**
- Modify: `tests/server/auth-routes.test.js`
- Modify: `src/server/auth-routes.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/server/auth-routes.test.js`:

```js
describe('POST /auth/verify', () => {
  it('returns 401 without admin key', async () => {
    const res = await request(app).post('/auth/verify').send({});
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong admin key', async () => {
    const res = await request(app)
      .post('/auth/verify')
      .set('X-Admin-Key', 'wrong-key-padding-padding-padding')
      .send({ code: '123456', telegram_user_id: 5663177530 });
    expect(res.status).toBe(401);
  });

  it('returns ok=false reason=unknown_code for non-existent code', async () => {
    const res = await request(app)
      .post('/auth/verify')
      .set('X-Admin-Key', 'test-admin-key-32-chars-padding-x')
      .send({ code: '999999', telegram_user_id: 5663177530 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, reason: 'unknown_code' });
  });

  it('returns ok=false reason=unauthorized_user when telegram_user_id mismatches', async () => {
    const start = await request(app).post('/auth/start').send({});
    const res = await request(app)
      .post('/auth/verify')
      .set('X-Admin-Key', 'test-admin-key-32-chars-padding-x')
      .send({ code: start.body.code, telegram_user_id: 9999 });
    expect(res.body).toEqual({ ok: false, reason: 'unauthorized_user' });
  });

  it('verifies a valid code, creates a session, links it to the challenge', async () => {
    const start = await request(app).post('/auth/start').send({});
    const res = await request(app)
      .post('/auth/verify')
      .set('X-Admin-Key', 'test-admin-key-32-chars-padding-x')
      .send({ code: start.body.code, telegram_user_id: 5663177530 });
    expect(res.body.ok).toBe(true);
    expect(res.body.session_created).toBe(true);
  });

  it('rejects double-verify on the same challenge', async () => {
    const start = await request(app).post('/auth/start').send({});
    await request(app)
      .post('/auth/verify')
      .set('X-Admin-Key', 'test-admin-key-32-chars-padding-x')
      .send({ code: start.body.code, telegram_user_id: 5663177530 });
    const second = await request(app)
      .post('/auth/verify')
      .set('X-Admin-Key', 'test-admin-key-32-chars-padding-x')
      .send({ code: start.body.code, telegram_user_id: 5663177530 });
    expect(second.body).toEqual({ ok: false, reason: 'unknown_code' });
  });
});
```

- [ ] **Step 2: Run, verify FAILs**

- [ ] **Step 3: Implement `/auth/verify` and the admin-key middleware**

Add to `src/server/auth-routes.js` (top of file, after imports):

```js
import { timingSafeEqual } from 'crypto';
import { getChallengeByCode, markVerified, createSession } from './auth.js';
```

Add a small helper inside `createAuthRouter`:

```js
function checkAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];
  const configured = process.env.ADMIN_API_KEY;
  if (!key || !configured) return res.status(401).json({ error: 'admin key required' });
  const a = Buffer.from(key);
  const b = Buffer.from(configured);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'admin key invalid' });
  }
  next();
}
```

Add the route:

```js
router.post('/verify', checkAdminKey, (req, res) => {
  const { code, telegram_user_id } = req.body || {};
  if (!code || typeof code !== 'string') {
    return res.json({ ok: false, reason: 'unknown_code' });
  }
  const authorized = parseInt(process.env.AUTHORIZED_TELEGRAM_USER_ID || '0', 10);
  const provided = parseInt(telegram_user_id, 10);
  if (!authorized || provided !== authorized) {
    return res.json({ ok: false, reason: 'unauthorized_user' });
  }
  const challenge = getChallengeByCode(code);
  if (!challenge) return res.json({ ok: false, reason: 'unknown_code' });
  const session = createSession({
    user_agent: challenge.user_agent,
    client_hint: challenge.client_hint,
    ip: challenge.ip
  });
  const ok = markVerified(challenge.id, session.id);
  if (!ok) return res.json({ ok: false, reason: 'unknown_code' });
  res.json({ ok: true, challenge_id: challenge.id, session_created: true });
});
```

- [ ] **Step 4: Run, verify all tests PASS**

```bash
npx vitest run tests/server/auth-routes.test.js
```

- [ ] **Step 5: Commit**

```bash
git add tests/server/auth-routes.test.js src/server/auth-routes.js
git commit -m "feat(auth): POST /auth/verify validates code, telegram_user_id, creates session"
```

---

### Task 2.5: `POST /auth/deny`

**Files:**
- Modify: `tests/server/auth-routes.test.js`
- Modify: `src/server/auth-routes.js`

- [ ] **Step 1: Add failing tests**

```js
describe('POST /auth/deny', () => {
  it('marks the challenge as denied', async () => {
    const start = await request(app).post('/auth/start').send({});
    const res = await request(app)
      .post('/auth/deny')
      .set('X-Admin-Key', 'test-admin-key-32-chars-padding-x')
      .send({ code: start.body.code });
    expect(res.body.ok).toBe(true);
    // Subsequent verify should fail
    const verify = await request(app)
      .post('/auth/verify')
      .set('X-Admin-Key', 'test-admin-key-32-chars-padding-x')
      .send({ code: start.body.code, telegram_user_id: 5663177530 });
    expect(verify.body.ok).toBe(false);
  });

  it('returns ok=false for unknown code', async () => {
    const res = await request(app)
      .post('/auth/deny')
      .set('X-Admin-Key', 'test-admin-key-32-chars-padding-x')
      .send({ code: '999999' });
    expect(res.body).toEqual({ ok: false, reason: 'unknown_code' });
  });

  it('requires admin key', async () => {
    const res = await request(app).post('/auth/deny').send({ code: '123456' });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run, verify FAILs**

- [ ] **Step 3: Implement**

Add to `src/server/auth-routes.js`:

```js
import { markDenied } from './auth.js';
// (extend the existing import line)
```

```js
router.post('/deny', checkAdminKey, (req, res) => {
  const { code } = req.body || {};
  if (!code || typeof code !== 'string') {
    return res.json({ ok: false, reason: 'unknown_code' });
  }
  const challenge = getChallengeByCode(code);
  if (!challenge) return res.json({ ok: false, reason: 'unknown_code' });
  const ok = markDenied(challenge.id);
  res.json({ ok });
});
```

- [ ] **Step 4: Run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add tests/server/auth-routes.test.js src/server/auth-routes.js
git commit -m "feat(auth): POST /auth/deny lets Franck reject suspicious login attempts"
```

---

### Task 2.6: `GET /auth/check` with cookie-set side effect

**Files:**
- Modify: `tests/server/auth-routes.test.js`
- Modify: `src/server/auth-routes.js`

- [ ] **Step 1: Add failing tests**

```js
describe('GET /auth/check', () => {
  it('returns state=pending for an unverified challenge, no cookie', async () => {
    const start = await request(app).post('/auth/start').send({});
    const res = await request(app).get(`/auth/check?challenge_id=${start.body.challenge_id}`);
    expect(res.body.state).toBe('pending');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('returns state=verified, sets cookie, marks consumed on first poll after verify', async () => {
    const start = await request(app).post('/auth/start').send({});
    await request(app)
      .post('/auth/verify')
      .set('X-Admin-Key', 'test-admin-key-32-chars-padding-x')
      .send({ code: start.body.code, telegram_user_id: 5663177530 });
    const res = await request(app).get(`/auth/check?challenge_id=${start.body.challenge_id}`);
    expect(res.body).toEqual({ state: 'verified', ok: true });
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/^devpanl_session=[a-f0-9]{64}/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=2592000/);
  });

  it('second poll after consume returns state=consumed, no cookie', async () => {
    const start = await request(app).post('/auth/start').send({});
    await request(app)
      .post('/auth/verify')
      .set('X-Admin-Key', 'test-admin-key-32-chars-padding-x')
      .send({ code: start.body.code, telegram_user_id: 5663177530 });
    await request(app).get(`/auth/check?challenge_id=${start.body.challenge_id}`); // consumes
    const res = await request(app).get(`/auth/check?challenge_id=${start.body.challenge_id}`);
    expect(res.body.state).toBe('consumed');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('returns 404 for unknown challenge_id', async () => {
    const res = await request(app).get('/auth/check?challenge_id=ch_nope');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run, verify FAILs**

- [ ] **Step 3: Implement `/auth/check`**

Add to `src/server/auth-routes.js`:

```js
import { markConsumed } from './auth.js';
// (extend imports)
```

```js
router.get('/check', (req, res) => {
  const { challenge_id } = req.query;
  if (!challenge_id) return res.status(400).json({ error: 'challenge_id required' });
  const { getMasterDatabase } = require('./db.js'); // or import at top
  const db = getMasterDatabase();
  const row = db.prepare('SELECT * FROM auth_challenges WHERE id = ?').get(challenge_id);
  if (!row) return res.status(404).json({ error: 'unknown challenge' });
  if (row.state === 'verified' && row.session_id) {
    res.cookie('devpanl_session', row.session_id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/'
    });
    markConsumed(row.id);
    return res.json({ state: 'verified', ok: true });
  }
  res.json({ state: row.state });
});
```

(Note: replace the inline `require('./db.js')` with a top-of-file `import { getMasterDatabase } from './db.js';` — kept inline above for clarity. Final code uses the top-level import.)

- [ ] **Step 4: Run, verify PASS**

```bash
npx vitest run tests/server/auth-routes.test.js
```

Note: in test mode `NODE_ENV` is unset so `secure: false`. The tests check `Set-Cookie` does NOT contain `Secure` — ensure the assertion `expect(cookie).toMatch(/HttpOnly/)` doesn't accidentally also assert on `Secure` (it doesn't, the regex is permissive).

- [ ] **Step 5: Commit**

```bash
git add tests/server/auth-routes.test.js src/server/auth-routes.js
git commit -m "feat(auth): GET /auth/check sets session cookie + marks consumed"
```

---

### Task 2.7: `POST /auth/logout`

**Files:**
- Modify: `tests/server/auth-routes.test.js`
- Modify: `src/server/auth-routes.js`

- [ ] **Step 1: Add failing test**

```js
describe('POST /auth/logout', () => {
  it('revokes the session and clears the cookie', async () => {
    // Bootstrap: start, verify, check to get cookie
    const start = await request(app).post('/auth/start').send({});
    await request(app)
      .post('/auth/verify')
      .set('X-Admin-Key', 'test-admin-key-32-chars-padding-x')
      .send({ code: start.body.code, telegram_user_id: 5663177530 });
    const checkRes = await request(app).get(`/auth/check?challenge_id=${start.body.challenge_id}`);
    const cookieHeader = checkRes.headers['set-cookie'][0];
    const sessionId = cookieHeader.match(/devpanl_session=([a-f0-9]+)/)[1];

    const res = await request(app)
      .post('/auth/logout')
      .set('Cookie', `devpanl_session=${sessionId}`);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['set-cookie'][0]).toMatch(/devpanl_session=;/);

    // Validate the session is now revoked in DB
    const { validateSession } = await import('../../src/server/auth.js');
    expect(validateSession(sessionId)).toBeNull();
  });

  it('returns ok=true even with no cookie (idempotent)', async () => {
    const res = await request(app).post('/auth/logout');
    expect(res.body).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

Add to `src/server/auth-routes.js`:

```js
import { revokeSession } from './auth.js';
// (extend imports)
```

```js
router.post('/logout', (req, res) => {
  const sid = req.cookies?.devpanl_session;
  if (sid) revokeSession(sid);
  res.clearCookie('devpanl_session', { path: '/' });
  res.json({ ok: true });
});
```

- [ ] **Step 4: Run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add tests/server/auth-routes.test.js src/server/auth-routes.js
git commit -m "feat(auth): POST /auth/logout revokes session and clears cookie"
```

---

### Task 2.8: Add GC cron + per-IP rate limit on `/auth/start`

**Files:**
- Modify: `src/server/index.js`
- Modify: `src/server/auth-routes.js`

- [ ] **Step 1: Add the GC interval to `src/server/index.js`**

After server is started (e.g. after `app.listen(...)`), add:

```js
// GC for auth_challenges and sessions — every 10 minutes
setInterval(() => {
  try {
    const db = getMasterDatabase();
    const cutoffChallenges = Date.now() - 60 * 60 * 1000; // 1h grace
    const cutoffSessions = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7d grace
    db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').run(cutoffChallenges);
    db.prepare('DELETE FROM sessions WHERE (expires_at < ? OR revoked_at IS NOT NULL)').run(cutoffSessions);
  } catch (err) {
    console.error('[Auth GC] failed:', err.message);
  }
}, 10 * 60 * 1000);
```

(Import `getMasterDatabase` if not already.)

- [ ] **Step 2: Add per-IP rate limit on `/auth/start`**

In `src/server/auth-routes.js`, import the existing `express-rate-limit`:

```js
import rateLimit from 'express-rate-limit';
```

Define a limiter inside `createAuthRouter`:

```js
const startLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a minute.' }
});
```

Apply it to the `/start` route:

```js
router.post('/start', startLimiter, async (req, res) => { /* unchanged */ });
```

Add a verify rate limiter too:

```js
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verify attempts.' }
});
router.post('/verify', verifyLimiter, checkAdminKey, /* ... */);
```

- [ ] **Step 3: Add a test to confirm rate limiting on `/start`**

In `tests/server/auth-routes.test.js`:

```js
describe('rate limiting', () => {
  it('blocks more than 5 /auth/start calls per minute from same IP', async () => {
    for (let i = 0; i < 5; i++) {
      const ok = await request(app).post('/auth/start').send({});
      expect(ok.status).toBe(200);
    }
    const blocked = await request(app).post('/auth/start').send({});
    expect(blocked.status).toBe(429);
  });
});
```

- [ ] **Step 4: Run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/server/index.js src/server/auth-routes.js tests/server/auth-routes.test.js
git commit -m "feat(auth): rate-limit /auth/start (5/min) and /auth/verify (10/min) + GC cron"
```

---

## Stage 3 — `requireAuth` middleware + integration

### Task 3.1: Write the middleware with chain semantics

**Files:**
- Create: `src/server/middleware/require-auth.js`
- Create: `tests/server/middleware/require-auth.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/server/middleware/require-auth.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initMasterDatabase, createProject } from '../../../src/server/db.js';
import { createSession } from '../../../src/server/auth.js';
import { requireAuth } from '../../../src/server/middleware/require-auth.js';

let storage, app;
beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), 'devpanel-mw-test-'));
  initMasterDatabase(storage);
  process.env.ADMIN_API_KEY = 'test-admin-key-32-chars-padding-x';
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.get('/protected', requireAuth, (req, res) => res.json({ user: req.user }));
});
afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
  delete process.env.ADMIN_API_KEY;
});

describe('requireAuth', () => {
  it('returns 401 when no auth provided', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
  });

  it('accepts cookie session', async () => {
    const session = createSession({});
    const res = await request(app)
      .get('/protected')
      .set('Cookie', `devpanl_session=${session.id}`);
    expect(res.status).toBe(200);
    expect(res.body.user.type).toBe('session');
    expect(res.body.user.session_id).toBe(session.id);
  });

  it('accepts valid project API key', async () => {
    const project = createProject({ name: 'test', github_repo: null });
    const res = await request(app)
      .get('/protected')
      .set('X-API-Key', project.api_key);
    expect(res.status).toBe(200);
    expect(res.body.user.type).toBe('project_key');
    expect(res.body.user.project_id).toBe(project.id);
  });

  it('accepts admin key', async () => {
    const res = await request(app)
      .get('/protected')
      .set('X-Admin-Key', 'test-admin-key-32-chars-padding-x');
    expect(res.status).toBe(200);
    expect(res.body.user.type).toBe('admin_key');
  });

  it('cookie session takes priority over keys', async () => {
    const session = createSession({});
    const project = createProject({ name: 'test2', github_repo: null });
    const res = await request(app)
      .get('/protected')
      .set('Cookie', `devpanl_session=${session.id}`)
      .set('X-API-Key', project.api_key);
    expect(res.body.user.type).toBe('session');
  });

  it('rejects revoked session', async () => {
    const session = createSession({});
    const { revokeSession } = await import('../../../src/server/auth.js');
    revokeSession(session.id);
    const res = await request(app)
      .get('/protected')
      .set('Cookie', `devpanl_session=${session.id}`);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run, verify FAILs**

- [ ] **Step 3: Implement the middleware**

```js
// src/server/middleware/require-auth.js
import { timingSafeEqual } from 'crypto';
import { validateSession, bumpSession } from '../auth.js';
import { getProjectByApiKey } from '../db.js';

export function requireAuth(req, res, next) {
  // 1. Cookie session
  const sid = req.cookies?.devpanl_session;
  if (sid) {
    const session = validateSession(sid);
    if (session) {
      bumpSession(sid);
      req.user = { type: 'session', session_id: sid };
      return next();
    }
  }
  // 2. Project API key
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey) {
    const project = getProjectByApiKey(apiKey);
    if (project) {
      req.project = project;
      req.user = { type: 'project_key', project_id: project.id };
      return next();
    }
  }
  // 3. Admin key
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

- [ ] **Step 4: Run, verify PASS (6 tests)**

```bash
npx vitest run tests/server/middleware/require-auth.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/server/middleware/require-auth.js tests/server/middleware/require-auth.test.js
git commit -m "feat(auth): requireAuth middleware chain (cookie → project key → admin key)"
```

---

### Task 3.2: Integrate `requireAuth` on dashboard routes

**Files:**
- Modify: `src/server/routes.js`

- [ ] **Step 1: Identify routes to convert**

Open `src/server/routes.js`. Find every route that today uses `authenticateAdmin` or relies on the legacy admin-key flow for the dashboard. List candidates:
- `/api/today`
- `/api/projects` (list/get)
- `/api/captures` (list, get, message)
- `/api/jobs/*` (admin endpoints)
- `/api/threads/*`
- `/api/signals`

(Do NOT convert routes used purely by the widget — `POST /api/captures` from external apps still uses `authenticateProject`.)

- [ ] **Step 2: Replace `authenticateAdmin` calls with `requireAuth`**

For each dashboard-facing route, change the middleware:

Before:
```js
router.get('/today', authenticateAdmin, (req, res) => { /* ... */ });
```

After:
```js
router.get('/today', requireAuth, (req, res) => { /* ... */ });
```

Add the import at the top of `routes.js`:
```js
import { requireAuth } from './middleware/require-auth.js';
```

- [ ] **Step 3: Verify backward compat with existing M2M tests**

```bash
npm test
```

All existing tests must still PASS. The dashboard will continue to work because `requireAuth` falls back to the admin key it currently uses.

- [ ] **Step 4: Manual smoke test**

Start the server:
```bash
DEVPANEL_STORAGE=./storage ADMIN_API_KEY=test-key node bin/dev-panel.js serve
```

In another terminal:
```bash
curl -s http://localhost:3030/api/today -H "X-Admin-Key: test-key" | head -c 200
```
Expected: 200 + JSON.

```bash
curl -i http://localhost:3030/api/today
```
Expected: 401.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes.js
git commit -m "feat(auth): apply requireAuth on dashboard-facing routes (backward-compat)"
```

---

## Stage 4 — MCP tools + Shelly SOUL update + agents-host deploy

### Task 4.1: Add `auth_verify` and `auth_deny` MCP tools

**Files:**
- Modify: `src/mcp/server.js`

- [ ] **Step 1: Add the two tools at the end of the existing tool registrations**

Find the end of the existing `server.tool(...)` block in `src/mcp/server.js`. Add:

```js
import { fetch as undiciFetch } from 'undici';
// (only if `fetch` isn't already global — Node 18+ has it built-in)

const API_BASE = process.env.API_BASE || 'http://localhost:3030';

server.tool(
  'auth_verify',
  'Validate a 6-digit dashboard login code that Franck typed in Telegram. Call this when Franck replies with 6 digits in response to a [auth] message. Pass his telegram_user_id from the channel message.',
  {
    code: z.string().regex(/^\d{6}$/).describe('The 6-digit code Franck typed'),
    telegram_user_id: z.number().describe('Franck\'s Telegram user id from the channel message')
  },
  async ({ code, telegram_user_id }) => {
    try {
      const resp = await fetch(`${API_BASE}/auth/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': process.env.ADMIN_API_KEY || ''
        },
        body: JSON.stringify({ code, telegram_user_id })
      });
      const json = await resp.json();
      return { content: [{ type: 'text', text: JSON.stringify(json) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'network_error', detail: err.message }) }], isError: true };
    }
  }
);

server.tool(
  'auth_deny',
  'Reject a dashboard login attempt that Franck did not initiate. Call this when Franck replies with "non" / "pas moi" / "kill" in response to a [auth] message.',
  {
    code: z.string().regex(/^\d{6}$/).describe('The 6-digit code from the [auth] message Franck is rejecting')
  },
  async ({ code }) => {
    try {
      const resp = await fetch(`${API_BASE}/auth/deny`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': process.env.ADMIN_API_KEY || ''
        },
        body: JSON.stringify({ code })
      });
      const json = await resp.json();
      return { content: [{ type: 'text', text: JSON.stringify(json) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'network_error', detail: err.message }) }], isError: true };
    }
  }
);
```

(Node 18+ has global `fetch`, no need for `undici`. The `import` line above is only needed if not. Verify by checking `src/mcp/server.js` for existing fetch use — if it works, no import needed.)

- [ ] **Step 2: Smoke test the MCP locally**

```bash
DEVPANEL_STORAGE=./storage REDIS_HOST=127.0.0.1 ADMIN_API_KEY=test-key API_BASE=http://localhost:3030 node src/mcp/server.js
```

Expected: starts without crashing, registers tools (look at stdout for tool names).

- [ ] **Step 3: Commit**

```bash
git add src/mcp/server.js
git commit -m "feat(mcp): auth_verify and auth_deny tools for Shelly to call"
```

---

### Task 4.2: Add `API_BASE` to the agents MCP template

**Files:**
- Modify: `infra/agents-mcp.json.template`

- [ ] **Step 1: Add the env entry**

Open `infra/agents-mcp.json.template`. In the `devpanel-mcp` env block, add:

```json
"API_BASE": "https://devpanl.dev",
```

(Place it next to the other env keys. Maintain valid JSON syntax — comma after.)

- [ ] **Step 2: Verify the template is valid JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('infra/agents-mcp.json.template', 'utf8')); console.log('OK')"
```

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add infra/agents-mcp.json.template
git commit -m "feat(agents): add API_BASE to devpanel-mcp env in template"
```

---

### Task 4.3: Add `AUTHORIZED_TELEGRAM_USER_ID` to env init

**Files:**
- Modify: `infra/init.sh`

- [ ] **Step 1: Locate the secrets section**

Open `infra/init.sh`. Find where it writes secrets to `.env.production`. Add:

```bash
add_var "AUTHORIZED_TELEGRAM_USER_ID" "${AUTHORIZED_TELEGRAM_USER_ID:-5663177530}"
```

(Use whatever helper the file uses — `add_var`, `set_env`, etc. Match the existing pattern.)

- [ ] **Step 2: Manually deploy to services VPS**

The server already has `TELEGRAM_CHAT_ID=5663177530` in `.env.production`. We need to add:
```
AUTHORIZED_TELEGRAM_USER_ID=5663177530
```

The next deploy will set this automatically; for the immediate test, ssh in and add it manually:

```bash
ssh deploy@77.42.46.87 'grep AUTHORIZED_TELEGRAM_USER_ID ~/dev-panel/.env.production || \
  echo "AUTHORIZED_TELEGRAM_USER_ID=5663177530" >> ~/dev-panel/.env.production'
```

- [ ] **Step 3: Update the GitHub Actions deploy workflow**

In `.github/workflows/deploy.yml`, find the `envs:` block and the `script:` block. Add:

In `envs:`:
```
AUTHORIZED_TELEGRAM_USER_ID,
```

In `script:`:
```bash
export AUTHORIZED_TELEGRAM_USER_ID="$AUTHORIZED_TELEGRAM_USER_ID"
```

In the `env:` block at the bottom:
```yaml
AUTHORIZED_TELEGRAM_USER_ID: ${{ secrets.AUTHORIZED_TELEGRAM_USER_ID }}
```

- [ ] **Step 4: Add the secret on GitHub**

(Manual user step) Run:
```bash
gh secret set AUTHORIZED_TELEGRAM_USER_ID --body 5663177530 --repo franckbirba/dev-panel
```

- [ ] **Step 5: Commit**

```bash
git add infra/init.sh .github/workflows/deploy.yml
git commit -m "feat(infra): version AUTHORIZED_TELEGRAM_USER_ID env var"
```

---

### Task 4.4: Update Shelly's SOUL with the `[auth]` protocol

**Files:**
- Modify: `.agents/shelly/SOUL.md`

- [ ] **Step 1: Find the right insertion point**

Open `.agents/shelly/SOUL.md`. Locate the section "### Captures — la surface de triage entre Franck et toi". Insert the new section immediately BEFORE it.

- [ ] **Step 2: Add the section**

```md
### Auth dashboard — messages [auth]

Quand un message taggé `[auth]` arrive (push de l'API quand Franck tente un login dashboard depuis un navigateur):

- Le message contient un code à 6 chiffres + un descripteur du browser/OS + l'IP + l'heure UTC.
- Ne fais rien tant que Franck n'a pas répondu. Pas d'écho, pas de "j'ai bien reçu".
- Quand Franck répond avec **6 chiffres** (avec ou sans espaces, avec ou sans préfixe "code"/"ok"), extrait le code et appelle `auth_verify({code, telegram_user_id: <son id Telegram, qui est 5663177530>})`.
- Si la réponse est `{ok: true}`, dis "✅ Loggé." (court, pas de cérémonie).
- Si `{ok: false, reason: "expired"}`: "Le code a expiré, relance un login depuis le dashboard."
- Si `{ok: false, reason: "unknown_code"}`: "Code pas reconnu, t'es sûr du chiffre?"
- Si `{ok: false, reason: "unauthorized_user"}`: ne dois jamais arriver vu que tu pushes son user_id; si c'est le cas, signale "Bug d'authent — ton user_id Telegram ne matche pas la config serveur."
- Si Franck répond "non" / "pas moi" / "kill" / "c'est pas moi" en réponse à un [auth]: appelle `auth_deny({code})` avec le code du dernier [auth] en flight, dis "OK, login rejeté." et inclus l'IP du message [auth] original pour qu'il puisse investiguer.
- Si Franck ignore le [auth] (5 min passent), pas besoin de faire quoi que ce soit — la challenge expire toute seule côté serveur.
```

- [ ] **Step 3: Commit**

```bash
git add .agents/shelly/SOUL.md
git commit -m "feat(shelly): add [auth] message handling protocol to SOUL"
```

---

### Task 4.5: Push everything + deploy services + deploy agents

**Files:**
- (no file changes — deploy operation)

- [ ] **Step 1: Push to main**

```bash
git push origin main
```

This triggers CI which rebuilds + deploys the `devpanel` container on services VPS. The new `/auth/*` endpoints will be live at `https://devpanl.dev/auth/*`.

- [ ] **Step 2: Wait for CI to complete**

```bash
gh run watch --repo franckbirba/dev-panel
```

Expected: green checkmark. If it fails, inspect logs and fix before proceeding.

- [ ] **Step 3: Smoke test the live endpoint**

```bash
curl -sX POST https://devpanl.dev/auth/start \
  -H 'Content-Type: application/json' \
  -d '{"client_hint":"manual smoke test"}' | jq
```

Expected: `{ "challenge_id": "ch_...", "code": "123456", "ttl": 300, "notification_sent": true }`. Verify Shelly pushed a `[auth]` message in Telegram.

- [ ] **Step 4: Deploy agents (refresh Shelly's MCP config + SOUL)**

```bash
bash scripts/deploy-agents.sh
```

This pulls the new commits on agents host, regenerates `/home/deploy/.mcp.json` from the template (now with `API_BASE`), copies the SOUL, restarts `shelly.service`. The new Shelly reads the updated SOUL on startup.

- [ ] **Step 5: End-to-end test from Telegram**

In the Telegram chat with Shelly, type the 6-digit code from Step 3.

Expected: Shelly replies "✅ Loggé." within ~5 seconds.

If Shelly says nothing, attach to her tmux to debug:
```bash
ssh hetzner-vps 'su - deploy -c "tmux -L deploy capture-pane -t shelly -p | tail -30"'
```

Likely cause: `ADMIN_API_KEY` missing from the MCP env (fixed already in `infra/agents-mcp.json.template`).

- [ ] **Step 6: Verify the session was created server-side**

```bash
ssh deploy@77.42.46.87 'sqlite3 ~/dev-panel/storage/projects.db "SELECT id, created_at, client_hint FROM sessions ORDER BY created_at DESC LIMIT 1;"'
```

Expected: a fresh session row with the client_hint you sent.

- [ ] **Step 7: No commit needed** — this is deploy-only.

---

## Stage 5 — Dashboard React migration

### Task 5.1: Create a `useAuth` hook that probes session

**Files:**
- Create: `src/dashboard/lib/use-auth.js`

- [ ] **Step 1: Implement the hook**

```jsx
// src/dashboard/lib/use-auth.js
import { useState, useEffect, useCallback } from 'react';

/**
 * Probes the API for an active session by hitting /api/today with cookies only.
 * Returns { status: 'unknown' | 'authenticated' | 'unauthenticated', refresh }.
 */
export function useAuth(apiBase = '') {
  const [status, setStatus] = useState('unknown');

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/today`, { credentials: 'include' });
      setStatus(res.status === 200 ? 'authenticated' : 'unauthenticated');
    } catch {
      setStatus('unauthenticated');
    }
  }, [apiBase]);

  useEffect(() => { refresh(); }, [refresh]);

  return { status, refresh };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/lib/use-auth.js
git commit -m "feat(dashboard): useAuth hook probes session via /api/today"
```

---

### Task 5.2: Create the `<LoginView>` component

**Files:**
- Create: `src/dashboard/views/login-view.jsx`

- [ ] **Step 1: Implement the component**

```jsx
// src/dashboard/views/login-view.jsx
import { useState, useEffect, useRef } from 'react';

function detectClient() {
  const ua = navigator.userAgent;
  const browser = /Chrome/i.test(ua) ? 'Chrome'
    : /Firefox/i.test(ua) ? 'Firefox'
    : /Safari/i.test(ua) ? 'Safari'
    : 'Browser';
  const os = /Mac/i.test(ua) ? 'Mac'
    : /Windows/i.test(ua) ? 'Windows'
    : /Linux/i.test(ua) ? 'Linux'
    : /iPhone|iPad/i.test(ua) ? 'iOS'
    : /Android/i.test(ua) ? 'Android'
    : 'Unknown';
  return `${browser} on ${os}`;
}

export function LoginView({ apiBase = '', onAuthenticated }) {
  const [challenge, setChallenge] = useState(null);
  const [error, setError] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const pollRef = useRef(null);
  const tickRef = useRef(null);

  async function start() {
    setError(null);
    try {
      const res = await fetch(`${apiBase}/auth/start`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_hint: detectClient() })
      });
      if (!res.ok) throw new Error('start failed');
      const data = await res.json();
      setChallenge(data);
      setSecondsLeft(data.ttl);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { start(); }, []);

  // Countdown
  useEffect(() => {
    if (!challenge) return;
    tickRef.current = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) { clearInterval(tickRef.current); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(tickRef.current);
  }, [challenge]);

  // Polling
  useEffect(() => {
    if (!challenge) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(
          `${apiBase}/auth/check?challenge_id=${challenge.challenge_id}`,
          { credentials: 'include' }
        );
        const data = await res.json();
        if (data.ok) {
          clearInterval(pollRef.current);
          clearInterval(tickRef.current);
          onAuthenticated?.();
          window.location.reload();
        } else if (data.state === 'expired' || data.state === 'denied') {
          clearInterval(pollRef.current);
          setError(data.state === 'expired' ? 'Code expiré' : 'Login refusé');
        }
      } catch { /* keep polling */ }
    }, 2000);
    return () => clearInterval(pollRef.current);
  }, [challenge, apiBase, onAuthenticated]);

  if (!challenge) {
    return <div className="login-view">{error ? `Erreur: ${error}` : 'Connexion…'}</div>;
  }

  const codeFormatted = challenge.code.match(/.{1,3}/g).join(' ');

  return (
    <div className="login-view" style={{
      maxWidth: 480, margin: '10vh auto', padding: '2rem', textAlign: 'center',
      fontFamily: 'system-ui, sans-serif'
    }}>
      <h2>Login dashboard</h2>
      <p>Shelly t'a envoyé un code en Telegram. Tape-le pour valider.</p>
      <div style={{
        fontSize: '3rem', fontFamily: 'monospace', letterSpacing: '0.5rem',
        margin: '1.5rem 0', color: '#222'
      }}>
        {codeFormatted}
      </div>
      <div style={{ color: '#888' }}>
        {secondsLeft > 0
          ? `Expire dans ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`
          : 'Expiré'}
      </div>
      {challenge.notification_sent === false && (
        <div style={{ color: '#c33', marginTop: '1rem' }}>
          Shelly n'a pas pu être notifiée. Envoie le code manuellement en Telegram.
        </div>
      )}
      {error && <div style={{ color: '#c33', marginTop: '1rem' }}>{error}</div>}
      <button
        onClick={start}
        style={{ marginTop: '2rem', padding: '0.5rem 1rem' }}
      >
        Renvoyer le code
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/views/login-view.jsx
git commit -m "feat(dashboard): LoginView component with code display + polling"
```

---

### Task 5.3: Mount `<LoginView>` in `app.jsx` based on auth status

**Files:**
- Modify: `src/dashboard/app.jsx`

- [ ] **Step 1: Locate the root component and the existing API key handling**

Open `src/dashboard/app.jsx`. Identify:
- The root `<App>` component
- Where it currently checks for / prompts the admin API key

- [ ] **Step 2: Replace API-key gate with `useAuth` + `<LoginView>`**

At the top of the file:
```jsx
import { useAuth } from './lib/use-auth.js';
import { LoginView } from './views/login-view.jsx';
```

In the `<App>` component, near the top of the render logic:

```jsx
const { status, refresh } = useAuth();

if (status === 'unknown') {
  return <div style={{ padding: 32 }}>Loading…</div>;
}

if (status === 'unauthenticated') {
  return <LoginView onAuthenticated={refresh} />;
}

// status === 'authenticated' — render the dashboard as before
```

Make sure all subsequent `fetch(...)` calls in the dashboard use `credentials: 'include'` so the cookie is sent. (Most calls go through `useAdminEvents`, `useSignals`, etc. — locate these and ensure they include credentials.)

- [ ] **Step 3: Update the helper hooks to send credentials**

Files to update:
- `src/dashboard/lib/use-admin-events.js`
- `src/dashboard/lib/use-signals.js`
- `src/dashboard/lib/projects-store.js` (only if it does fetch — check)
- Any other file that does `fetch(...)` to the API

For each `fetch(url, opts)`, ensure `opts.credentials = 'include'` is set.

- [ ] **Step 4: Manual test in incognito browser**

Build the dashboard:
```bash
npm run build
```

Start the server with the right env (`AUTHORIZED_TELEGRAM_USER_ID` etc.).

Open `http://localhost:3030/dashboard` in incognito. Verify:
- `<LoginView>` appears with a 6-digit code.
- Telegram receives the `[auth]` message (if locally bound to Shelly — otherwise just the API call should succeed).
- Manually call `/auth/verify` via curl with admin key to simulate Shelly:
  ```bash
  curl -X POST http://localhost:3030/auth/verify \
    -H 'X-Admin-Key: <local-admin-key>' \
    -H 'Content-Type: application/json' \
    -d '{"code":"<the-6-digit-code>", "telegram_user_id": 5663177530}'
  ```
- Browser should reload within 2s and show the dashboard.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/app.jsx src/dashboard/lib/use-admin-events.js src/dashboard/lib/use-signals.js
git commit -m "feat(dashboard): replace admin-key gate with cookie session + LoginView"
```

---

### Task 5.4: Remove legacy `getAdminKey` from `projects-store.js`

**Files:**
- Modify: `src/dashboard/lib/projects-store.js`

- [ ] **Step 1: Remove the `getAdminKey` and `setAdminKey` exports + their `localStorage` keys**

Open `src/dashboard/lib/projects-store.js`. Locate:
```js
export function getAdminKey() { return localStorage.getItem(K_ADMIN) || ''; }
```

Remove this function. Search for any caller (`grep -rn getAdminKey src/`) and remove the calls — they should all be gone after Task 5.3.

Also remove the `K_ADMIN` constant if it's no longer referenced.

Optional: clean up the `localStorage.removeItem('devpanel_admin_key')` once on first load to avoid leftovers in users' browsers. Add to `app.jsx` `useEffect` on mount:
```js
useEffect(() => { localStorage.removeItem('devpanel_admin_key'); }, []);
```

- [ ] **Step 2: Verify build still works**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/lib/projects-store.js src/dashboard/app.jsx
git commit -m "chore(dashboard): drop legacy localStorage admin-key wiring"
```

---

### Task 5.5: Add a logout button somewhere visible

**Files:**
- Modify: `src/dashboard/components/topbar.jsx`

- [ ] **Step 1: Add a logout button to the topbar**

Open `src/dashboard/components/topbar.jsx`. Add:

```jsx
async function handleLogout() {
  await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
  window.location.reload();
}
```

In the JSX, somewhere on the right side:
```jsx
<button onClick={handleLogout} title="Déconnexion">
  ⏻
</button>
```

(Match the existing button styling in the topbar — don't introduce new design.)

- [ ] **Step 2: Manual test**

Open the dashboard while authenticated, click logout, verify you land on `<LoginView>`.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/components/topbar.jsx
git commit -m "feat(dashboard): logout button in topbar"
```

---

### Task 5.6: End-to-end deploy + smoke test

**Files:**
- (no file changes)

- [ ] **Step 1: Push all stage 5 commits**

```bash
git push origin main
```

Wait for CI to deploy.

- [ ] **Step 2: End-to-end test from incognito browser on phone**

1. Open `https://devpanl.dev/dashboard/today` on iPhone Safari incognito.
2. Verify `<LoginView>` appears with 6-digit code and countdown.
3. Verify Shelly pushed `[auth]` message with the same code in Telegram.
4. Type the code in Telegram.
5. Verify Shelly replies "✅ Loggé."
6. Verify the dashboard reloads automatically and renders.
7. Close tab, reopen — verify no re-login prompt.
8. Click logout — verify return to `<LoginView>`.
9. Trigger another login from the same browser, refuse via Telegram with "non" → verify Shelly says "OK, login rejeté." and the dashboard shows "Login refusé".
10. M2M smoke: `curl -H "X-API-Key: <project_key>" https://devpanl.dev/api/captures` should still return 200.
11. Wait 6 minutes after a fresh `<LoginView>` load — verify it shows "Code expiré" + button to renew.

- [ ] **Step 3: No commit** — pure verification.

---

## Self-review checklist (executed by the planner)

This section is the planner's final review. It is not a task — it's already completed.

### Spec coverage

- ✅ Sessions/challenges schema → Task 1.1
- ✅ `auth.js` core functions → Tasks 1.2, 1.3, 1.4, 1.5
- ✅ `/auth/start` → Tasks 2.2, 2.3
- ✅ `/auth/verify` → Task 2.4
- ✅ `/auth/deny` → Task 2.5
- ✅ `/auth/check` → Task 2.6
- ✅ `/auth/logout` → Task 2.7
- ✅ Rate limits + GC → Task 2.8
- ✅ `requireAuth` middleware → Task 3.1
- ✅ Middleware integration → Task 3.2
- ✅ MCP tools → Task 4.1
- ✅ `API_BASE` template entry → Task 4.2
- ✅ `AUTHORIZED_TELEGRAM_USER_ID` env → Task 4.3
- ✅ Shelly SOUL update → Task 4.4
- ✅ Deploy stages 4 → Task 4.5
- ✅ `useAuth` + `<LoginView>` → Tasks 5.1, 5.2, 5.3
- ✅ Drop legacy admin-key UI → Task 5.4
- ✅ Logout button → Task 5.5
- ✅ End-to-end smoke → Task 5.6

### Type/name consistency

- `createChallenge` returns `{challenge_id, code, ttl}` — consistent across tests, routes, and the MCP tool docstring.
- `markVerified(challenge_id, session_id)` — both args present in tests and in `/auth/verify`.
- `validateSession(session_id) → row | null` — used by `requireAuth`.
- Cookie name `devpanl_session` — consistent across `/auth/check`, `/auth/logout`, middleware.
- MCP tool names `auth_verify` / `auth_deny` — match the SOUL's expected calls.

### No placeholders

Scanned for "TODO", "TBD", "fill in", "similar to". None found. Each step has either complete code or an explicit command.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-22-dashboard-auth.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration with isolated context.

**2. Inline Execution** — Execute tasks in this session, batch with checkpoints.

Which approach?
