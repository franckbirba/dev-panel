# Multi-dev Shelly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let 3 additional devs chat with Shelly through their own paired Telegram bots, while keeping a single Claude process and a shared studio memory.

**Architecture:** A new Postgres table `dev_bots` holds `(token, label, owner)` rows. A forked telegram channel plugin (`telegram-multi`) reads that table, spawns one grammy `Bot` per active row, hot-reloads every 30s, and tags each inbound with `bot_label` + `tg_user_id`. Devpanel API exposes `/api/dev-bots` CRUD; Shelly's persona learns a `/pair` flow.

**Tech Stack:** Node 20 / ESM, Express, Bun, grammy, Postgres (pgvector instance, services VPS), vitest + supertest, Apache-2.0 plugin fork.

---

## Spec reference

`docs/superpowers/specs/2026-04-25-multi-dev-shelly-design.md` (commit `acdad80`).

## File structure

| File | Purpose | Action |
|---|---|---|
| `infra/migrations/004-dev-bots.sql` | Create `dev_bots` table on the shared `agent_memory` Postgres. | Create |
| `src/server/dev-bots.js` | DAO: list/insert/revoke/find-by-token, owner update, getMe validator. | Create |
| `src/server/routes-dev-bots.js` | Express router — `POST/GET/DELETE /api/dev-bots`, `PATCH /api/dev-bots/:id/owner`. | Create |
| `src/server/index.js` | Mount the new router. | Modify |
| `tests/server/dev-bots.test.js` | DAO + route unit tests with mocked `getMe`. | Create |
| `tests/server/dev-bots-seed.test.js` | Backward-compat: empty table + env → seed Franck's row. | Create |
| `plugins/telegram-multi/package.json` | Plugin manifest (Bun, grammy, pg, MCP SDK). | Create |
| `plugins/telegram-multi/server.ts` | The fork: multi-bot boot, hot-reload, decorated inbound, routed outbound. | Create |
| `plugins/telegram-multi/src/registry.ts` | DB-backed bot registry (read `dev_bots`, diff against running bots). | Create |
| `plugins/telegram-multi/src/loader.ts` | Pulls `dev_bots` rows via `pg`, exposes `loadActiveBots()` + `markRevoked()`. | Create |
| `plugins/telegram-multi/tests/registry.test.ts` | Hot-reload diff logic. | Create |
| `plugins/telegram-multi/tests/loader.test.ts` | DB queries against a real Postgres (testcontainers or env-gated). | Create |
| `plugins/telegram-multi/README.md` | How to install on hetzner-vps + env vars. | Create |
| `.agents/shelly/SOUL.md` | Append "Pairing protocol" section. | Modify |
| `infra/agents-mcp.json.template` | Swap `claude-plugins-official:telegram` → `devpanl:telegram-multi`. | Modify |
| `scripts/deploy-agents.sh` | Push the plugin to `~/.claude/plugins/` on hetzner-vps. | Modify |
| `tests/integration/multi-dev-pair.test.js` | End-to-end pair → first inbound → revoke. | Create |

## Conventions

- Dates in commit subjects use ISO (e.g. `feat(dev-bots): …`).
- Test framework: **vitest** (already in use). Use `supertest` for Express routes, `pg` (Pool) directly for Postgres tests.
- Postgres tests require a running pgvector container — gate with `process.env.PG_HOST` and `it.skip` if absent (matches existing `tests/server/pg.test.js` style).
- Plugin is TypeScript-on-Bun (matches upstream). Tests use `bun test`.
- All commits authored by `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 1: Postgres migration — `dev_bots` table

**Files:**
- Create: `infra/migrations/004-dev-bots.sql`

- [ ] **Step 1: Write the migration**

Create `infra/migrations/004-dev-bots.sql`:

```sql
-- 004-dev-bots.sql
-- Multi-tenant Telegram pairing for Shelly.
-- One row per paired bot. The telegram-multi plugin polls SELECT * WHERE
-- status='active' every 30s and spawns one grammy Bot per row.

BEGIN;

CREATE TABLE IF NOT EXISTS dev_bots (
  id                   SERIAL PRIMARY KEY,
  bot_token            TEXT NOT NULL UNIQUE,
  bot_username         TEXT NOT NULL,
  bot_label            TEXT NOT NULL UNIQUE,
  owner_tg_user_id     BIGINT,
  owner_first_name     TEXT,
  paired_by_tg_user_id BIGINT NOT NULL,
  paired_at            TIMESTAMPTZ DEFAULT now(),
  status               TEXT DEFAULT 'active',
  last_inbound_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS dev_bots_status_idx ON dev_bots(status);

COMMIT;
```

- [ ] **Step 2: Apply locally and confirm**

Run:
```bash
psql "$DATABASE_URL" -f infra/migrations/004-dev-bots.sql
psql "$DATABASE_URL" -c "\d dev_bots"
```
Expected: table description shows the 10 columns + 2 indexes (`dev_bots_pkey`, `dev_bots_status_idx`, plus unique indexes on `bot_token` and `bot_label`).

- [ ] **Step 3: Commit**

```bash
git add infra/migrations/004-dev-bots.sql
git commit -m "feat(dev-bots): postgres migration for paired-bot registry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: DAO — `src/server/dev-bots.js`

**Files:**
- Create: `src/server/dev-bots.js`
- Test: `tests/server/dev-bots.test.js`

- [ ] **Step 1: Write the failing tests for the DAO**

Create `tests/server/dev-bots.test.js`:

```js
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pool } from '../../src/server/pg.js';
import {
  insertDevBot, listActiveDevBots, listAllDevBots,
  findDevBotByToken, findDevBotById, revokeDevBot,
  updateDevBotOwner, touchInbound
} from '../../src/server/dev-bots.js';

const HAS_PG = Boolean(process.env.PG_HOST);

describe.skipIf(!HAS_PG)('dev-bots DAO', () => {
  beforeAll(async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS dev_bots (
      id SERIAL PRIMARY KEY, bot_token TEXT UNIQUE NOT NULL,
      bot_username TEXT NOT NULL, bot_label TEXT UNIQUE NOT NULL,
      owner_tg_user_id BIGINT, owner_first_name TEXT,
      paired_by_tg_user_id BIGINT NOT NULL,
      paired_at TIMESTAMPTZ DEFAULT now(), status TEXT DEFAULT 'active',
      last_inbound_at TIMESTAMPTZ)`);
  });
  beforeEach(async () => { await pool.query('TRUNCATE dev_bots RESTART IDENTITY'); });
  afterAll(async () => { await pool.query('DROP TABLE IF EXISTS dev_bots'); });

  it('inserts and lists a new bot', async () => {
    const id = await insertDevBot({
      bot_token: 'T1', bot_username: 'alice_bot', bot_label: 'alice',
      paired_by_tg_user_id: 5663177530n
    });
    expect(id).toBeGreaterThan(0);
    const active = await listActiveDevBots();
    expect(active).toHaveLength(1);
    expect(active[0].bot_label).toBe('alice');
    expect(active[0].owner_tg_user_id).toBeNull();
  });

  it('rejects duplicate token', async () => {
    await insertDevBot({ bot_token: 'T1', bot_username: 'a_bot', bot_label: 'a', paired_by_tg_user_id: 1n });
    await expect(insertDevBot({
      bot_token: 'T1', bot_username: 'b_bot', bot_label: 'b', paired_by_tg_user_id: 1n
    })).rejects.toThrow(/duplicate|unique/i);
  });

  it('finds by token', async () => {
    await insertDevBot({ bot_token: 'T1', bot_username: 'a_bot', bot_label: 'a', paired_by_tg_user_id: 1n });
    const row = await findDevBotByToken('T1');
    expect(row.bot_label).toBe('a');
    expect(await findDevBotByToken('missing')).toBeNull();
  });

  it('revokes a bot', async () => {
    const id = await insertDevBot({ bot_token: 'T1', bot_username: 'a_bot', bot_label: 'a', paired_by_tg_user_id: 1n });
    await revokeDevBot(id);
    expect(await listActiveDevBots()).toHaveLength(0);
    expect(await listAllDevBots()).toHaveLength(1);
  });

  it('updates owner on first inbound', async () => {
    const id = await insertDevBot({ bot_token: 'T1', bot_username: 'a_bot', bot_label: 'a', paired_by_tg_user_id: 1n });
    await updateDevBotOwner(id, { owner_tg_user_id: 999n, owner_first_name: 'Alice' });
    const row = await findDevBotById(id);
    expect(String(row.owner_tg_user_id)).toBe('999');
    expect(row.owner_first_name).toBe('Alice');
  });

  it('touches last_inbound_at', async () => {
    const id = await insertDevBot({ bot_token: 'T1', bot_username: 'a_bot', bot_label: 'a', paired_by_tg_user_id: 1n });
    await touchInbound(id);
    const row = await findDevBotById(id);
    expect(row.last_inbound_at).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/server/dev-bots.test.js`
Expected: FAIL with "Cannot find module ../../src/server/dev-bots.js" (or skip if PG_HOST not set — set it for local: `PG_HOST=localhost PG_PORT=5432 PG_USER=affine PG_PASSWORD=… PG_DATABASE=agent_memory npx vitest …`).

- [ ] **Step 3: Write the DAO**

Create `src/server/dev-bots.js`:

```js
import { pool } from './pg.js';

export async function insertDevBot({ bot_token, bot_username, bot_label, paired_by_tg_user_id }) {
  const { rows } = await pool.query(
    `INSERT INTO dev_bots (bot_token, bot_username, bot_label, paired_by_tg_user_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [bot_token, bot_username, bot_label, paired_by_tg_user_id]
  );
  return rows[0].id;
}

export async function listActiveDevBots() {
  const { rows } = await pool.query(
    `SELECT * FROM dev_bots WHERE status='active' ORDER BY id`
  );
  return rows;
}

export async function listAllDevBots() {
  const { rows } = await pool.query(`SELECT * FROM dev_bots ORDER BY id`);
  return rows;
}

export async function findDevBotByToken(bot_token) {
  const { rows } = await pool.query(
    `SELECT * FROM dev_bots WHERE bot_token=$1`, [bot_token]
  );
  return rows[0] ?? null;
}

export async function findDevBotByLabel(bot_label) {
  const { rows } = await pool.query(
    `SELECT * FROM dev_bots WHERE bot_label=$1`, [bot_label]
  );
  return rows[0] ?? null;
}

export async function findDevBotById(id) {
  const { rows } = await pool.query(`SELECT * FROM dev_bots WHERE id=$1`, [id]);
  return rows[0] ?? null;
}

export async function revokeDevBot(id) {
  await pool.query(`UPDATE dev_bots SET status='revoked' WHERE id=$1`, [id]);
}

export async function updateDevBotOwner(id, { owner_tg_user_id, owner_first_name }) {
  await pool.query(
    `UPDATE dev_bots SET owner_tg_user_id=$1, owner_first_name=$2 WHERE id=$3`,
    [owner_tg_user_id, owner_first_name, id]
  );
}

export async function touchInbound(id) {
  await pool.query(`UPDATE dev_bots SET last_inbound_at=now() WHERE id=$1`, [id]);
}

// Validate a bot token by calling Telegram getMe. Returns { ok, username } or
// { ok:false, error }. Pure HTTP — no DB side effects.
export async function validateTelegramToken(token) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const body = await r.json();
    if (!r.ok || !body.ok) {
      return { ok: false, error: body.description || `HTTP ${r.status}` };
    }
    return { ok: true, username: body.result.username };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PG_HOST=… npx vitest run tests/server/dev-bots.test.js`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/dev-bots.js tests/server/dev-bots.test.js
git commit -m "feat(dev-bots): DAO for paired-bot registry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Express routes — `/api/dev-bots`

**Files:**
- Create: `src/server/routes-dev-bots.js`
- Modify: `src/server/index.js` (mount router)
- Test: extend `tests/server/dev-bots.test.js`

- [ ] **Step 1: Write the failing route tests**

Append to `tests/server/dev-bots.test.js` (inside the same `describe.skipIf(!HAS_PG)` block):

```js
  describe('POST /api/dev-bots', () => {
    let app, request;
    beforeEach(async () => {
      const express = (await import('express')).default;
      const { mountDevBotsRoutes } = await import('../../src/server/routes-dev-bots.js');
      const { vi } = await import('vitest');
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (url.endsWith('/getMe')) {
          if (url.includes('/botGOOD:')) {
            return { ok: true, json: async () => ({ ok: true, result: { username: 'good_bot' } }) };
          }
          return { ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) };
        }
        return { ok: true, json: async () => ({}) };
      }));
      app = express();
      app.use(express.json());
      mountDevBotsRoutes(app);
      const supertest = (await import('supertest')).default;
      request = supertest(app);
    });

    it('creates a paired bot when getMe succeeds', async () => {
      const r = await request.post('/api/dev-bots').send({
        token: 'GOOD:abc', label: 'alice', paired_by_tg_user_id: '5663177530'
      });
      expect(r.status).toBe(201);
      expect(r.body.bot_username).toBe('good_bot');
      expect(r.body.bot_label).toBe('alice');
    });

    it('rejects an invalid token', async () => {
      const r = await request.post('/api/dev-bots').send({
        token: 'BAD:xyz', label: 'alice', paired_by_tg_user_id: '5663177530'
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/Unauthorized/);
    });

    it('returns 409 on duplicate token', async () => {
      await request.post('/api/dev-bots').send({
        token: 'GOOD:abc', label: 'alice', paired_by_tg_user_id: '1'
      });
      const r = await request.post('/api/dev-bots').send({
        token: 'GOOD:abc', label: 'alice2', paired_by_tg_user_id: '1'
      });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/already paired/i);
    });

    it('GET /api/dev-bots lists active rows', async () => {
      await request.post('/api/dev-bots').send({
        token: 'GOOD:abc', label: 'alice', paired_by_tg_user_id: '1'
      });
      const r = await request.get('/api/dev-bots');
      expect(r.status).toBe(200);
      expect(r.body).toHaveLength(1);
    });

    it('DELETE /api/dev-bots/:id revokes', async () => {
      const c = await request.post('/api/dev-bots').send({
        token: 'GOOD:abc', label: 'alice', paired_by_tg_user_id: '1'
      });
      const r = await request.delete(`/api/dev-bots/${c.body.id}`);
      expect(r.status).toBe(204);
      const list = await request.get('/api/dev-bots?status=active');
      expect(list.body).toHaveLength(0);
    });

    it('PATCH /api/dev-bots/:id/owner sets owner', async () => {
      const c = await request.post('/api/dev-bots').send({
        token: 'GOOD:abc', label: 'alice', paired_by_tg_user_id: '1'
      });
      const r = await request.patch(`/api/dev-bots/${c.body.id}/owner`).send({
        owner_tg_user_id: '999', owner_first_name: 'Alice'
      });
      expect(r.status).toBe(200);
      expect(r.body.owner_first_name).toBe('Alice');
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PG_HOST=… npx vitest run tests/server/dev-bots.test.js`
Expected: 6 new tests fail with "Cannot find module routes-dev-bots.js".

- [ ] **Step 3: Write the router**

Create `src/server/routes-dev-bots.js`:

```js
import express from 'express';
import {
  insertDevBot, listActiveDevBots, listAllDevBots,
  findDevBotById, revokeDevBot, updateDevBotOwner,
  validateTelegramToken
} from './dev-bots.js';

export function mountDevBotsRoutes(app) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const { token, label, paired_by_tg_user_id } = req.body ?? {};
    if (!token || !label || !paired_by_tg_user_id) {
      return res.status(400).json({ error: 'token, label, paired_by_tg_user_id required' });
    }
    const validation = await validateTelegramToken(token);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    try {
      const id = await insertDevBot({
        bot_token: token,
        bot_username: validation.username,
        bot_label: label,
        paired_by_tg_user_id: BigInt(paired_by_tg_user_id)
      });
      const row = await findDevBotById(id);
      res.status(201).json(serialize(row));
    } catch (err) {
      if (/duplicate|unique/i.test(err.message)) {
        return res.status(409).json({ error: 'bot already paired' });
      }
      throw err;
    }
  });

  router.get('/', async (req, res) => {
    const rows = req.query.status === 'active'
      ? await listActiveDevBots()
      : await listAllDevBots();
    res.json(rows.map(serialize));
  });

  router.delete('/:id', async (req, res) => {
    await revokeDevBot(parseInt(req.params.id, 10));
    res.status(204).end();
  });

  router.patch('/:id/owner', async (req, res) => {
    const { owner_tg_user_id, owner_first_name } = req.body ?? {};
    await updateDevBotOwner(parseInt(req.params.id, 10), {
      owner_tg_user_id: owner_tg_user_id ? BigInt(owner_tg_user_id) : null,
      owner_first_name: owner_first_name ?? null
    });
    const row = await findDevBotById(parseInt(req.params.id, 10));
    res.json(serialize(row));
  });

  app.use('/api/dev-bots', router);
}

function serialize(row) {
  if (!row) return null;
  return {
    ...row,
    owner_tg_user_id: row.owner_tg_user_id != null ? String(row.owner_tg_user_id) : null,
    paired_by_tg_user_id: String(row.paired_by_tg_user_id)
  };
}
```

- [ ] **Step 4: Mount the router in `src/server/index.js`**

Find the section where other routers are mounted (e.g., near `app.use('/api', …)`). Add:

```js
import { mountDevBotsRoutes } from './routes-dev-bots.js';
// … inside createServer() / startServer(), after app.use(express.json()):
mountDevBotsRoutes(app);
```

Use Read first to find the exact insertion point in `src/server/index.js`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `PG_HOST=… npx vitest run tests/server/dev-bots.test.js`
Expected: all 12 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes-dev-bots.js src/server/index.js tests/server/dev-bots.test.js
git commit -m "feat(dev-bots): /api/dev-bots CRUD endpoints

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Backward-compat seed

**Files:**
- Modify: `src/server/dev-bots.js` (add `seedFromEnvIfEmpty`)
- Modify: `src/server/index.js` (call seed on boot)
- Test: `tests/server/dev-bots-seed.test.js` (new file)

- [ ] **Step 1: Write the failing seed test**

Create `tests/server/dev-bots-seed.test.js`:

```js
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { pool } from '../../src/server/pg.js';
import { seedFromEnvIfEmpty, listAllDevBots } from '../../src/server/dev-bots.js';

const HAS_PG = Boolean(process.env.PG_HOST);

describe.skipIf(!HAS_PG)('dev-bots backward-compat seed', () => {
  beforeAll(async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS dev_bots (
      id SERIAL PRIMARY KEY, bot_token TEXT UNIQUE NOT NULL,
      bot_username TEXT NOT NULL, bot_label TEXT UNIQUE NOT NULL,
      owner_tg_user_id BIGINT, owner_first_name TEXT,
      paired_by_tg_user_id BIGINT NOT NULL,
      paired_at TIMESTAMPTZ DEFAULT now(), status TEXT DEFAULT 'active',
      last_inbound_at TIMESTAMPTZ)`);
  });
  beforeEach(async () => { await pool.query('TRUNCATE dev_bots RESTART IDENTITY'); });
  afterAll(async () => { await pool.query('DROP TABLE IF EXISTS dev_bots'); });

  it('seeds franck row when table empty and env set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ ok: true, result: { username: 'franck_bot' } })
    })));
    await seedFromEnvIfEmpty({
      TELEGRAM_BOT_TOKEN: 'FRANCK:abc',
      TELEGRAM_CHAT_ID: '5663177530'
    });
    const rows = await listAllDevBots();
    expect(rows).toHaveLength(1);
    expect(rows[0].bot_label).toBe('franck');
    expect(String(rows[0].owner_tg_user_id)).toBe('5663177530');
  });

  it('is a no-op when env is missing', async () => {
    await seedFromEnvIfEmpty({});
    expect(await listAllDevBots()).toHaveLength(0);
  });

  it('is a no-op when table already has rows', async () => {
    await pool.query(
      `INSERT INTO dev_bots (bot_token, bot_username, bot_label, paired_by_tg_user_id)
       VALUES ('X', 'x_bot', 'x', 1)`
    );
    await seedFromEnvIfEmpty({
      TELEGRAM_BOT_TOKEN: 'FRANCK:abc',
      TELEGRAM_CHAT_ID: '5663177530'
    });
    expect(await listAllDevBots()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `PG_HOST=… npx vitest run tests/server/dev-bots-seed.test.js`
Expected: FAIL — `seedFromEnvIfEmpty is not a function`.

- [ ] **Step 3: Implement `seedFromEnvIfEmpty`**

Append to `src/server/dev-bots.js`:

```js
// Backward-compat: pre-multi-tenant deploys had a single TELEGRAM_BOT_TOKEN
// in env. On first boot of telegram-multi, if no rows exist and env is set,
// seed Franck's row so existing installs migrate transparently.
export async function seedFromEnvIfEmpty(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { seeded: false, reason: 'env missing' };
  const existing = await listAllDevBots();
  if (existing.length > 0) return { seeded: false, reason: 'rows exist' };
  const validation = await validateTelegramToken(token);
  if (!validation.ok) return { seeded: false, reason: validation.error };
  const id = await insertDevBot({
    bot_token: token,
    bot_username: validation.username,
    bot_label: 'franck',
    paired_by_tg_user_id: BigInt(chatId)
  });
  await updateDevBotOwner(id, {
    owner_tg_user_id: BigInt(chatId),
    owner_first_name: 'Franck'
  });
  return { seeded: true, id };
}
```

- [ ] **Step 4: Wire it into `src/server/index.js`**

Inside `startServer()` (or wherever async boot happens), call after the DB is reachable:

```js
import { seedFromEnvIfEmpty } from './dev-bots.js';
// …
try {
  const result = await seedFromEnvIfEmpty();
  if (result.seeded) console.log(`[dev-bots] seeded franck row id=${result.id}`);
} catch (err) {
  console.error('[dev-bots] seed failed (non-fatal):', err.message);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `PG_HOST=… npx vitest run tests/server/dev-bots-seed.test.js`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/dev-bots.js src/server/index.js tests/server/dev-bots-seed.test.js
git commit -m "feat(dev-bots): backward-compat seed from TELEGRAM_BOT_TOKEN env

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Plugin scaffolding — `plugins/telegram-multi/`

**Files:**
- Create: `plugins/telegram-multi/package.json`
- Create: `plugins/telegram-multi/README.md`
- Create: `plugins/telegram-multi/.gitignore`

- [ ] **Step 1: Write `package.json`**

Create `plugins/telegram-multi/package.json`:

```json
{
  "name": "devpanl-telegram-multi",
  "version": "0.1.0",
  "license": "Apache-2.0",
  "type": "module",
  "bin": "./server.ts",
  "scripts": {
    "start": "bun install --no-summary && bun server.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "grammy": "^1.21.0",
    "pg": "^8.11.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0",
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 2: Write `README.md`**

Create `plugins/telegram-multi/README.md`:

```markdown
# telegram-multi

Multi-tenant Telegram channel for Claude Code. Apache-2.0 fork of
`claude-plugins-official:telegram` v0.0.6.

Polls one grammy `Bot` per active row in the shared Postgres `dev_bots`
table. Hot-reloads every 30s (no plugin restart on pair/revoke).

## Env (read from `~/.claude/channels/telegram/.env`)

- `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE` — the
  shared `agent_memory` Postgres on the services VPS (10.0.0.2:5432).
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — optional, only used by
  devpanel-api's first-boot seed. The plugin itself reads tokens from `dev_bots`.

## Rules

- Exactly one process at a time per token (Telegram's `getUpdates` rule).
  This plugin enforces it across all bots it manages because they're all
  inside one Bun process.
- If you run a second telegram-multi pointing at the same Postgres on a
  different host, both will try to poll every token → 409 Conflict storms.
  Don't do that.
```

- [ ] **Step 3: Write `.gitignore`**

Create `plugins/telegram-multi/.gitignore`:

```
node_modules/
bun.lock
*.log
```

- [ ] **Step 4: Commit**

```bash
git add plugins/telegram-multi/
git commit -m "feat(telegram-multi): plugin scaffolding (Apache-2.0 fork)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Plugin loader — `loader.ts`

**Files:**
- Create: `plugins/telegram-multi/src/loader.ts`
- Create: `plugins/telegram-multi/tests/loader.test.ts`

- [ ] **Step 1: Write the failing loader tests**

Create `plugins/telegram-multi/tests/loader.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import pg from 'pg';
import { loadActiveBots, markRevoked, touchInbound, updateOwner } from '../src/loader.ts';

const HAS_PG = Boolean(process.env.PG_HOST);
const pool = new pg.Pool({
  host: process.env.PG_HOST, port: +(process.env.PG_PORT ?? 5432),
  user: process.env.PG_USER, password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE
});

describe.skipIf(!HAS_PG)('loader', () => {
  beforeAll(async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS dev_bots (
      id SERIAL PRIMARY KEY, bot_token TEXT UNIQUE NOT NULL,
      bot_username TEXT NOT NULL, bot_label TEXT UNIQUE NOT NULL,
      owner_tg_user_id BIGINT, owner_first_name TEXT,
      paired_by_tg_user_id BIGINT NOT NULL,
      paired_at TIMESTAMPTZ DEFAULT now(), status TEXT DEFAULT 'active',
      last_inbound_at TIMESTAMPTZ)`);
  });
  beforeEach(async () => { await pool.query('TRUNCATE dev_bots RESTART IDENTITY'); });
  afterAll(async () => { await pool.query('DROP TABLE IF EXISTS dev_bots'); await pool.end(); });

  it('loads active bots', async () => {
    await pool.query(`INSERT INTO dev_bots (bot_token, bot_username, bot_label, paired_by_tg_user_id)
                      VALUES ('T1', 'a_bot', 'a', 1), ('T2', 'b_bot', 'b', 1)`);
    await pool.query(`UPDATE dev_bots SET status='revoked' WHERE bot_label='b'`);
    const bots = await loadActiveBots();
    expect(bots).toHaveLength(1);
    expect(bots[0].bot_label).toBe('a');
  });

  it('marks a bot revoked', async () => {
    const r = await pool.query(`INSERT INTO dev_bots (bot_token, bot_username, bot_label, paired_by_tg_user_id)
                                VALUES ('T1', 'a_bot', 'a', 1) RETURNING id`);
    await markRevoked(r.rows[0].id);
    const bots = await loadActiveBots();
    expect(bots).toHaveLength(0);
  });

  it('updates owner', async () => {
    const r = await pool.query(`INSERT INTO dev_bots (bot_token, bot_username, bot_label, paired_by_tg_user_id)
                                VALUES ('T1', 'a_bot', 'a', 1) RETURNING id`);
    await updateOwner(r.rows[0].id, 999n, 'Alice');
    const { rows } = await pool.query(`SELECT * FROM dev_bots WHERE id=$1`, [r.rows[0].id]);
    expect(rows[0].owner_first_name).toBe('Alice');
  });

  it('touches last_inbound_at', async () => {
    const r = await pool.query(`INSERT INTO dev_bots (bot_token, bot_username, bot_label, paired_by_tg_user_id)
                                VALUES ('T1', 'a_bot', 'a', 1) RETURNING id`);
    await touchInbound(r.rows[0].id);
    const { rows } = await pool.query(`SELECT last_inbound_at FROM dev_bots WHERE id=$1`, [r.rows[0].id]);
    expect(rows[0].last_inbound_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd plugins/telegram-multi && bun install && PG_HOST=… bun test tests/loader.test.ts`
Expected: FAIL — `Cannot find module ../src/loader.ts`.

- [ ] **Step 3: Write the loader**

Create `plugins/telegram-multi/src/loader.ts`:

```ts
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.PG_HOST,
  port: parseInt(process.env.PG_PORT ?? '5432', 10),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  max: 4
});

export type DevBotRow = {
  id: number;
  bot_token: string;
  bot_username: string;
  bot_label: string;
  owner_tg_user_id: bigint | null;
  owner_first_name: string | null;
};

export async function loadActiveBots(): Promise<DevBotRow[]> {
  const { rows } = await pool.query(
    `SELECT id, bot_token, bot_username, bot_label,
            owner_tg_user_id, owner_first_name
     FROM dev_bots WHERE status='active' ORDER BY id`
  );
  return rows;
}

export async function markRevoked(id: number): Promise<void> {
  await pool.query(`UPDATE dev_bots SET status='revoked' WHERE id=$1`, [id]);
}

export async function updateOwner(id: number, tgUserId: bigint, firstName: string): Promise<void> {
  await pool.query(
    `UPDATE dev_bots SET owner_tg_user_id=$1, owner_first_name=$2 WHERE id=$3`,
    [tgUserId, firstName, id]
  );
}

export async function touchInbound(id: number): Promise<void> {
  await pool.query(`UPDATE dev_bots SET last_inbound_at=now() WHERE id=$1`, [id]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd plugins/telegram-multi && PG_HOST=… bun test tests/loader.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/telegram-multi/src/loader.ts plugins/telegram-multi/tests/loader.test.ts
git commit -m "feat(telegram-multi): loader for dev_bots Postgres registry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Plugin registry — hot-reload diff

**Files:**
- Create: `plugins/telegram-multi/src/registry.ts`
- Create: `plugins/telegram-multi/tests/registry.test.ts`

- [ ] **Step 1: Write the failing registry tests**

Create `plugins/telegram-multi/tests/registry.test.ts`:

```ts
import { describe, it, expect, mock } from 'bun:test';
import { diffBots, BotRegistry } from '../src/registry.ts';
import type { DevBotRow } from '../src/loader.ts';

const row = (id: number, label: string, token: string): DevBotRow => ({
  id, bot_token: token, bot_username: `${label}_bot`, bot_label: label,
  owner_tg_user_id: null, owner_first_name: null
});

describe('diffBots', () => {
  it('detects added bots', () => {
    const r = diffBots([], [row(1, 'a', 'T1')]);
    expect(r.added.map(b => b.id)).toEqual([1]);
    expect(r.removed).toEqual([]);
  });

  it('detects removed bots', () => {
    const r = diffBots([row(1, 'a', 'T1')], []);
    expect(r.removed.map(b => b.id)).toEqual([1]);
    expect(r.added).toEqual([]);
  });

  it('detects token rotation as remove+add', () => {
    const r = diffBots([row(1, 'a', 'T1_old')], [row(1, 'a', 'T1_new')]);
    expect(r.removed.map(b => b.id)).toEqual([1]);
    expect(r.added.map(b => b.id)).toEqual([1]);
  });

  it('no-op when sets equal', () => {
    const cur = [row(1, 'a', 'T1'), row(2, 'b', 'T2')];
    const r = diffBots(cur, cur);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });
});

describe('BotRegistry.reconcile', () => {
  it('starts new bots and stops removed ones', async () => {
    const started: number[] = [];
    const stopped: number[] = [];
    const reg = new BotRegistry({
      start: async (b) => { started.push(b.id); },
      stop:  async (b) => { stopped.push(b.id); }
    });
    await reg.reconcile([row(1, 'a', 'T1')]);
    await reg.reconcile([row(1, 'a', 'T1'), row(2, 'b', 'T2')]);
    await reg.reconcile([row(2, 'b', 'T2')]);
    expect(started).toEqual([1, 2]);
    expect(stopped).toEqual([1]);
  });

  it('handles start failure gracefully (does not retain in current set)', async () => {
    const started: number[] = [];
    const reg = new BotRegistry({
      start: async (b) => { started.push(b.id); throw new Error('boom'); },
      stop:  async () => {}
    });
    await reg.reconcile([row(1, 'a', 'T1')]);
    // Next reconcile with same row should attempt start again because the
    // failed bot wasn't added to the current set.
    await reg.reconcile([row(1, 'a', 'T1')]);
    expect(started).toEqual([1, 1]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd plugins/telegram-multi && bun test tests/registry.test.ts`
Expected: FAIL — `Cannot find module ../src/registry.ts`.

- [ ] **Step 3: Implement the registry**

Create `plugins/telegram-multi/src/registry.ts`:

```ts
import type { DevBotRow } from './loader.ts';

// Two rows describe "the same bot" iff (id, bot_token) match. A token rotation
// is observed as remove+add even though the id stays the same — desired,
// because we need to re-spawn the grammy Bot with the new token.
function key(b: DevBotRow): string {
  return `${b.id}:${b.bot_token}`;
}

export function diffBots(current: DevBotRow[], next: DevBotRow[]) {
  const curMap = new Map(current.map(b => [key(b), b]));
  const nextMap = new Map(next.map(b => [key(b), b]));
  const added: DevBotRow[] = [];
  const removed: DevBotRow[] = [];
  for (const [k, b] of nextMap) if (!curMap.has(k)) added.push(b);
  for (const [k, b] of curMap)  if (!nextMap.has(k)) removed.push(b);
  return { added, removed };
}

type Lifecycle = {
  start: (b: DevBotRow) => Promise<void>;
  stop:  (b: DevBotRow) => Promise<void>;
};

export class BotRegistry {
  private current: DevBotRow[] = [];
  constructor(private lifecycle: Lifecycle) {}

  async reconcile(next: DevBotRow[]): Promise<void> {
    const { added, removed } = diffBots(this.current, next);
    for (const b of removed) {
      try { await this.lifecycle.stop(b); }
      catch (err) { console.error(`[registry] stop ${b.bot_label} failed:`, err); }
    }
    // Drop removed bots immediately so subsequent reconciles don't double-stop.
    this.current = this.current.filter(b => !removed.some(r => key(r) === key(b)));
    for (const b of added) {
      try {
        await this.lifecycle.start(b);
        this.current.push(b);
      } catch (err) {
        console.error(`[registry] start ${b.bot_label} failed:`, err);
        // Intentionally do NOT push — next reconcile will retry.
      }
    }
  }

  snapshot(): DevBotRow[] {
    return [...this.current];
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd plugins/telegram-multi && bun test tests/registry.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/telegram-multi/src/registry.ts plugins/telegram-multi/tests/registry.test.ts
git commit -m "feat(telegram-multi): registry with hot-reload diff

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Plugin server — multi-bot boot + decorated inbound + routed outbound

**Files:**
- Copy: `~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/server.ts` → `plugins/telegram-multi/server.ts` (verbatim, then patch).

This task adapts the upstream `server.ts` (1032 LOC). We do **not** reproduce the whole file in this plan — we list the exact patches.

- [ ] **Step 1: Copy upstream server.ts verbatim**

```bash
cp ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/server.ts plugins/telegram-multi/server.ts
```

- [ ] **Step 2: Patch — single-token boot → multi-token boot**

In `plugins/telegram-multi/server.ts`, find this block (around line 42-86):

```ts
const TOKEN = process.env.TELEGRAM_BOT_TOKEN
// …
if (!TOKEN) { … process.exit(1) }
// …
const bot = new Bot(TOKEN)
let botUsername = ''
```

Replace with:

```ts
import { loadActiveBots, markRevoked, touchInbound, updateOwner, type DevBotRow } from './src/loader.ts'
import { BotRegistry } from './src/registry.ts'

// Each running grammy Bot, keyed by dev_bots.id. Keeps the Bot instance and
// its botUsername (needed for mention-handling on group chats — same as
// upstream's botUsername global, just per-bot now).
type RunningBot = { row: DevBotRow; bot: Bot; username: string }
const running = new Map<number, RunningBot>()

const registry = new BotRegistry({
  start: async (row) => {
    const b = new Bot(row.bot_token)
    const me = await b.api.getMe()
    wireBotHandlers(b, row)
    b.start({ drop_pending_updates: true }).catch(err => {
      console.error(`[telegram-multi] bot ${row.bot_label} polling error:`, err)
      // 401 = token revoked at TG side. Mark revoked so we stop trying.
      if (err?.error_code === 401) markRevoked(row.id).catch(() => {})
    })
    running.set(row.id, { row, bot: b, username: me.username ?? '' })
    console.log(`[telegram-multi] started bot ${row.bot_label} (@${me.username})`)
  },
  stop: async (row) => {
    const r = running.get(row.id)
    if (!r) return
    await r.bot.stop().catch(() => {})
    running.delete(row.id)
    console.log(`[telegram-multi] stopped bot ${row.bot_label}`)
  }
})

async function reconcileLoop() {
  try {
    const next = await loadActiveBots()
    await registry.reconcile(next)
  } catch (err) {
    console.error('[telegram-multi] reconcile failed:', err)
  }
}

await reconcileLoop()  // initial boot
setInterval(reconcileLoop, 30_000)

if (running.size === 0) {
  console.warn('[telegram-multi] no active bots in dev_bots — waiting for /pair')
}
```

- [ ] **Step 3: Patch — extract per-bot handler wiring**

In upstream `server.ts`, the message handler is registered on the global `bot` (e.g., `bot.on('message', async ctx => {…})`). Extract this into a function `wireBotHandlers(bot, row)` so each per-row Bot gets the same handlers.

Locate every `bot.on(…)`, `bot.command(…)`, `bot.catch(…)` registration, move them inside:

```ts
function wireBotHandlers(bot: Bot, row: DevBotRow) {
  bot.on('message', async (ctx) => {
    // existing message handler body, but with two changes:
    // 1. add bot_label and tg_user_id to the channel envelope (Step 4)
    // 2. capture owner if owner_tg_user_id IS NULL (Step 5)
    // 3. touchInbound(row.id) (fire-and-forget)
    touchInbound(row.id).catch(() => {})
    // … existing body …
  })
  bot.catch(err => {
    console.error(`[telegram-multi] bot ${row.bot_label} caught:`, err)
  })
}
```

- [ ] **Step 4: Patch — decorated inbound envelope**

Upstream emits the inbound message as XML on stdout (or via the MCP tool — check upstream code). Find where the `<channel source="telegram" …>` envelope is built (search for `source="telegram"` in the file).

Add `bot_label` and `tg_user_id` (and `first_name`) attributes:

```ts
// before
`<channel source="telegram"${imagePathAttr}>${body}</channel>`
// after
`<channel source="telegram" bot_label="${row.bot_label}" tg_user_id="${ctx.from?.id ?? ''}" first_name="${escapeAttr(ctx.from?.first_name ?? '')}"${imagePathAttr}>${body}</channel>`
```

Add a small `escapeAttr` helper if not already present:

```ts
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
```

- [ ] **Step 5: Patch — capture owner on first inbound**

Inside the message handler, before emitting the envelope:

```ts
if (row.owner_tg_user_id == null && ctx.from?.id) {
  await updateOwner(row.id, BigInt(ctx.from.id), ctx.from.first_name ?? '')
  row.owner_tg_user_id = BigInt(ctx.from.id)
  row.owner_first_name = ctx.from.first_name ?? ''
}
```

- [ ] **Step 6: Patch — outbound routing**

Find the MCP tool that sends a reply (likely `send_message` or similar — search for `bot.api.sendMessage` in upstream).

Upstream uses the global `bot`. Replace with per-channel routing: the reply tool's input should include `bot_label` (or it's inferred from the conversation context the plugin tracks). For v1, the simplest contract:

```ts
// reply tool handler
const target = z.object({
  bot_label: z.string(),     // NEW required field
  chat_id: z.union([z.string(), z.number()]),
  text: z.string(),
  // … rest of upstream's reply-tool schema
}).parse(args)

const r = [...running.values()].find(rb => rb.row.bot_label === target.bot_label)
if (!r) throw new Error(`bot_label ${target.bot_label} not running`)
await r.bot.api.sendMessage(target.chat_id, target.text, /* upstream extras */)
```

Update the tool's MCP `description` to mention `bot_label` is required and is read from the `<channel bot_label=…>` attribute of the inbound message Shelly is replying to.

- [ ] **Step 7: Smoke-test compile**

Run: `cd plugins/telegram-multi && bun install && bun --no-install build server.ts > /dev/null` (or `bun check server.ts` if available).
Expected: no type errors. Fix any until clean.

- [ ] **Step 8: Commit**

```bash
git add plugins/telegram-multi/server.ts
git commit -m "feat(telegram-multi): multi-bot boot, decorated inbound, routed outbound

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Wire Shelly's MCP config to the new plugin

**Files:**
- Modify: `infra/agents-mcp.json.template`
- Modify: `scripts/deploy-agents.sh` (push plugin folder to hetzner-vps)

- [ ] **Step 1: Read the current template**

Run: `Read /Users/franckbirba/DEV/dev-panel/infra/agents-mcp.json.template`

- [ ] **Step 2: Swap the channel reference**

Find the entry for `claude-plugins-official:telegram` (or the channel block). Replace the plugin spec with the local install path of `telegram-multi`:

```json
"channels": {
  "telegram": {
    "command": "bun",
    "args": ["/home/deploy/.claude/plugins/telegram-multi/server.ts"],
    "env": {
      "PG_HOST": "10.0.0.2",
      "PG_PORT": "5432",
      "PG_USER": "affine",
      "PG_PASSWORD": "${PG_PASSWORD}",
      "PG_DATABASE": "agent_memory"
    }
  }
}
```

The exact JSON shape depends on what's already in the template — preserve adjacent keys, only swap the telegram channel definition. If the template currently uses `plugin:telegram@claude-plugins-official`, the launch command in `CLAUDE.md` will also need updating in Task 11.

- [ ] **Step 3: Update `scripts/deploy-agents.sh` to ship the plugin**

Find where the script rsyncs `.agents/` to the agents host. Add a sibling rsync for the plugin:

```bash
rsync -av --delete \
  --exclude node_modules --exclude bun.lock \
  plugins/telegram-multi/ \
  deploy@hetzner-vps:/home/deploy/.claude/plugins/telegram-multi/
ssh deploy@hetzner-vps 'cd /home/deploy/.claude/plugins/telegram-multi && bun install --no-summary'
```

- [ ] **Step 4: Commit**

```bash
git add infra/agents-mcp.json.template scripts/deploy-agents.sh
git commit -m "feat(telegram-multi): wire plugin into agents-mcp config + deploy script

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Shelly persona — Pairing protocol

**Files:**
- Modify: `.agents/shelly/SOUL.md`

- [ ] **Step 1: Read current SOUL.md**

Run: `Read /Users/franckbirba/DEV/dev-panel/.agents/shelly/SOUL.md`

- [ ] **Step 2: Append the new section**

Add this section to `.agents/shelly/SOUL.md`, just before the final "Si tu crashes" section:

```markdown
## Pairing — onboarder de nouveaux devs

Maintenant tu n'es plus single-tenant. L'équipe grandit, chaque dev a son propre bot Telegram qu'il a créé via @BotFather. Le plugin `telegram-multi` poll *N* bots simultanément, et chaque message inbound porte deux nouveaux attributs :

- `bot_label` — le nom court du bot (ex: `franck`, `alice`, `bob`)
- `tg_user_id` — l'ID Telegram numérique de l'expéditeur

### Quand Franck DM ton bot avec `/pair <token> <label>`

1. Vérifie l'allowlist : `tg_user_id` doit être `5663177530` (Franck). Sinon réponds : "Seul Franck peut pairer un nouveau bot pour l'instant."
2. Call `POST /api/dev-bots` avec `{token, label, paired_by_tg_user_id: tg_user_id}`.
3. Sur 201 : "OK, `<bot_username>` est en ligne. Dis à <label> de me dire bonjour."
4. Sur 400 : "Token invalide ou révoqué — vérifie chez @BotFather."
5. Sur 409 : "Ce bot est déjà pairé sous le label `<existing>`."

### Quand un nouveau dev DM son bot pour la première fois

Un message inbound arrive avec un `bot_label` que tu n'avais jamais vu. Le plugin a déjà capturé `owner_tg_user_id` côté DB — pas besoin de le faire toi-même. Ce que tu dois faire :

1. Présente-toi en français, naturellement : "Salut <first_name>, je suis Shelly. Je vois Franck a paire ton bot. Tu peux me demander 'ça donne quoi?' pour le pulse du studio, ou 'lance ZENO-42' pour dispatch un work item."
2. À partir de là, traite ce dev comme un peer de Franck — full powers, mêmes tools, mêmes mémoires partagées. Pas de scoping, pas de filtrage.

### Le deploy gate (la seule restriction)

Tout dispatch avec `agent=deploy` est verrouillé à un allowlist. Pour l'instant : Franck uniquement (`tg_user_id = 5663177530`).

Si un autre dev dit "deploy" :
> "Le deploy est verrouillé pour Franck pour l'instant. Je peux te draft le dispatch et lui demander, OK?"

Si oui, DM Franck via son bot (`bot_label="franck"`) :
> "<first_name> veut deploy <branch>. OK?"

### Mémoire et continuité

La mémoire partagée (`memories` pgvector) est studio-wide — tout ce que tu écris pour un dev est visible quand tu réponds à un autre. C'est voulu : c'est l'avantage d'avoir une seule Shelly pour toute l'équipe. Continue à `memory_search` avant les décisions et `memory_write` après. Ajoute juste le `first_name` du dev concerné dans le `content` quand c'est pertinent ("Alice a confirmé qu'on drop la capture 47…").

La conversation court-terme par contre est isolée par bot : Alice ne voit pas ce que Bob t'a dit dans son fil. C'est gratuit, le plugin gère ça.
```

- [ ] **Step 3: Commit**

```bash
git add .agents/shelly/SOUL.md
git commit -m "feat(shelly): pairing protocol for multi-dev Telegram bots

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Update CLAUDE.md launch invocation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Read CLAUDE.md and find the Shelly relaunch block**

Run: `Read /Users/franckbirba/DEV/dev-panel/CLAUDE.md` (search section "Relaunching Shelly").

- [ ] **Step 2: Update the `--channels` flag**

Replace `plugin:telegram@claude-plugins-official` with `plugin:telegram-multi@devpanl` in the relaunch command. Also update the surrounding paragraphs:

- "the official Telegram channel plugin" → "the `telegram-multi` plugin (Apache-2.0 fork of `claude-plugins-official:telegram` with multi-bot support)"
- The "Token + chat ID come from `/home/deploy/.claude/channels/telegram/.env`" sentence: add "Tokens for paired devs come from the shared Postgres `dev_bots` table; the env file only carries the DB connection vars and Franck's legacy `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (used by the first-boot seed)."

- [ ] **Step 3: Update the runtime topology table (the "Who polls" section)**

Add a sentence under "Who polls the Telegram bot token":

> "With `telegram-multi`, the plugin manages N grammy `Bot` instances *inside* one Bun process. Telegram's one-poller-per-token rule still holds — there is exactly one `getUpdates` long-poll per token, just N tokens now. Do not run a second `telegram-multi` against the same `dev_bots` table from another host or all tokens will 409."

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): document telegram-multi plugin and multi-bot rule

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Integration test — end-to-end pair → first inbound → revoke

**Files:**
- Create: `tests/integration/multi-dev-pair.test.js`

- [ ] **Step 1: Write the integration test**

Create `tests/integration/multi-dev-pair.test.js`:

```js
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { pool } from '../../src/server/pg.js';
import { mountDevBotsRoutes } from '../../src/server/routes-dev-bots.js';
import { listActiveDevBots, updateDevBotOwner, findDevBotByToken } from '../../src/server/dev-bots.js';

const HAS_PG = Boolean(process.env.PG_HOST);

describe.skipIf(!HAS_PG)('multi-dev pairing — end-to-end', () => {
  let app, request;

  beforeAll(async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS dev_bots (
      id SERIAL PRIMARY KEY, bot_token TEXT UNIQUE NOT NULL,
      bot_username TEXT NOT NULL, bot_label TEXT UNIQUE NOT NULL,
      owner_tg_user_id BIGINT, owner_first_name TEXT,
      paired_by_tg_user_id BIGINT NOT NULL,
      paired_at TIMESTAMPTZ DEFAULT now(), status TEXT DEFAULT 'active',
      last_inbound_at TIMESTAMPTZ)`);
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (typeof url === 'string' && url.includes('/getMe')) {
        return { ok: true, json: async () => ({ ok: true, result: { username: 'alice_bot' } }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
    app = express();
    app.use(express.json());
    mountDevBotsRoutes(app);
    request = supertest(app);
  });

  beforeEach(async () => { await pool.query('TRUNCATE dev_bots RESTART IDENTITY'); });
  afterAll(async () => { await pool.query('DROP TABLE IF EXISTS dev_bots'); });

  it('pair → loader sees row → first inbound captures owner → revoke removes row', async () => {
    // 1. Franck pairs Alice's bot via the API (simulating Shelly's POST).
    const pair = await request.post('/api/dev-bots').send({
      token: 'ALICE:tok', label: 'alice', paired_by_tg_user_id: '5663177530'
    });
    expect(pair.status).toBe(201);
    expect(pair.body.bot_username).toBe('alice_bot');

    // 2. The plugin's loader (simulated as a direct DAO call) now sees the row.
    const active = await listActiveDevBots();
    expect(active).toHaveLength(1);
    expect(active[0].bot_label).toBe('alice');
    expect(active[0].owner_tg_user_id).toBeNull();

    // 3. Alice DMs her bot — the plugin captures owner via PATCH.
    const owned = await request.patch(`/api/dev-bots/${pair.body.id}/owner`).send({
      owner_tg_user_id: '999', owner_first_name: 'Alice'
    });
    expect(owned.status).toBe(200);
    const row = await findDevBotByToken('ALICE:tok');
    expect(String(row.owner_tg_user_id)).toBe('999');
    expect(row.owner_first_name).toBe('Alice');

    // 4. Franck revokes the bot.
    const del = await request.delete(`/api/dev-bots/${pair.body.id}`);
    expect(del.status).toBe(204);
    expect(await listActiveDevBots()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `PG_HOST=… npx vitest run tests/integration/multi-dev-pair.test.js`
Expected: 1 test passes.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/multi-dev-pair.test.js
git commit -m "test(dev-bots): end-to-end pairing integration

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Manual smoke test on production

**Files:** none — this is a runbook executed on the services + agents VPS after the previous commits are deployed.

- [ ] **Step 1: Apply the migration on services Postgres**

```bash
ssh deploy@77.42.46.87 'docker exec -i devpanel-postgres psql -U affine -d agent_memory' < infra/migrations/004-dev-bots.sql
```
Expected: `BEGIN`, `CREATE TABLE`, `CREATE INDEX`, `COMMIT`.

- [ ] **Step 2: Deploy devpanel-api (auto via push to main)**

```bash
git push origin main
```
Wait for `.github/workflows/deploy.yml` to refresh `devpanel` container. Verify: `curl https://devpanl.dev/api/dev-bots -H "X-API-Key: $KEY"` → should return `[]`.

- [ ] **Step 3: Run agents deploy script (ships plugin)**

```bash
./scripts/deploy-agents.sh
```
Verify on hetzner-vps:
```bash
ssh hetzner-vps 'ls /home/deploy/.claude/plugins/telegram-multi/server.ts'
```

- [ ] **Step 4: Restart Shelly**

```bash
ssh hetzner-vps 'sudo systemctl restart shelly.service'
sleep 8
ssh hetzner-vps 'pgrep -af "bun server.ts"'
```
Expected: exactly one process running `bun server.ts` from `/home/deploy/.claude/plugins/telegram-multi/`.

- [ ] **Step 5: Verify backward-compat seed populated Franck's row**

```bash
ssh deploy@77.42.46.87 'docker exec devpanel-postgres psql -U affine -d agent_memory -c "SELECT id, bot_label, bot_username, status FROM dev_bots"'
```
Expected: one row with `bot_label='franck'`, `status='active'`.

- [ ] **Step 6: Smoke-test pairing with a throwaway bot**

a. Create a test bot via @BotFather → get token `TEST:abc...`.
b. Franck DMs his Shelly bot: `/pair TEST:abc... testbot`
c. Wait 30s for hot-reload.
d. Verify:
```bash
ssh deploy@77.42.46.87 'docker exec devpanel-postgres psql -U affine -d agent_memory -c "SELECT bot_label FROM dev_bots WHERE status=active"'
```
Expected: `franck` and `testbot`.
e. DM the test bot anything → Shelly should reply through it (greeting).
f. Verify owner captured:
```bash
ssh deploy@77.42.46.87 'docker exec devpanel-postgres psql -U affine -d agent_memory -c "SELECT bot_label, owner_first_name FROM dev_bots"'
```
Expected: `testbot` row has `owner_first_name='Franck'` (or whatever Franck's TG name is).

- [ ] **Step 7: Smoke-test revoke**

```bash
curl -X DELETE https://devpanl.dev/api/dev-bots/<testbot_id> -H "X-API-Key: $KEY"
sleep 35
```
DM the test bot → no reply (plugin should have stopped that grammy Bot).

- [ ] **Step 8: Cleanup**

```bash
curl -X DELETE https://devpanl.dev/api/dev-bots/<testbot_id> -H "X-API-Key: $KEY"   # already revoked, idempotent
# Optionally hard-delete the row:
ssh deploy@77.42.46.87 'docker exec devpanel-postgres psql -U affine -d agent_memory -c "DELETE FROM dev_bots WHERE bot_label=testbot"'
```
Revoke the test bot at @BotFather.

- [ ] **Step 9: Onboard the 3 real devs**

For each dev:
1. Dev → @BotFather → token.
2. Dev → Franck out-of-band → token.
3. Franck → his Shelly bot: `/pair <token> <label>`.
4. Dev DMs their own bot to introduce themselves.

Document any rough edges and capture them as memory_writes for v2 polish.

---

## Self-review

**Spec coverage check:**
- ✅ `dev_bots` table — Task 1.
- ✅ Forked plugin `telegram-multi` — Tasks 5–8.
- ✅ `/pair` flow — Task 10 (persona) + Task 3 (API).
- ✅ Backward-compat seed — Task 4.
- ✅ Decorated inbound (`bot_label`, `tg_user_id`, `first_name`) — Task 8 step 4.
- ✅ Owner capture on first inbound — Task 8 step 5 + Task 3 PATCH endpoint.
- ✅ Outbound routing per `bot_label` — Task 8 step 6.
- ✅ Hot-reload every 30s — Task 8 step 2 (`setInterval(reconcileLoop, 30_000)`).
- ✅ Crash safety / per-bot fault isolation — Task 8 step 2 (`bot.start().catch`) + Task 7 (registry retains nothing on start failure).
- ✅ Deploy gate — Task 10 (persona).
- ✅ Migration / deploy runbook — Task 13.
- ⚠️ Spec mentions `notifyJob()` defaults to Franck's bot. Currently it uses env vars (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`) which keep working — no code change required, addressed implicitly by the seed keeping Franck's row in DB for parity. Documented in Task 11 (CLAUDE.md update).

**Placeholder scan:** none.

**Type consistency check:**
- `DevBotRow` defined in `loader.ts` (Task 6) and re-imported in `registry.ts` (Task 7) and `server.ts` (Task 8). Consistent.
- `bot_label` is the join key everywhere (DAO, API, plugin, persona). Consistent.
- `tg_user_id` typed as `BIGINT` in DB, `bigint` in TS, serialized as String in JSON (per `serialize()` in Task 3). Consistent.

Plan is complete.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-25-multi-dev-shelly.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
