# Team Routing Per Project — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route widget bug/feature reports to the right person via their paired Telegram bot, based on a per-project `label → member` map editable from the dashboard.

**Architecture:** Two new Postgres tables (`team_members`, `team_routing`) live next to `dev_bots` in shared PG. New REST routes under `/api/team` (project-key auth) drive a Settings UI tab and a widget category dropdown. `POST /api/tickets` emits a `[ticket-new]` system message; Shelly classifies (or honours user's category), calls a new idempotent `POST /api/tickets/:id/route` to persist + resolve the target, then DMs the member on their paired bot using the existing telegram-multi `reply` MCP tool with the `[thread:ticket/<id>]` prefix so replies route back to the ticket conversation.

**Tech Stack:** Postgres 16, better-sqlite3, Node 22 / Express, Vitest, React 18, Tailwind, MCP SDK 1.x, telegram-multi (Bun + grammy).

**Spec:** `docs/superpowers/specs/2026-04-25-team-routing-design.md`

---

## File Structure

**Created:**
- `infra/migrations/006-team-routing.sql` — schema for `team_members` + `team_routing`.
- `src/server/team.js` — DAO: CRUD on members, routing, label resolution.
- `src/server/routes-team.js` — Express router for `/api/team/*`.
- `src/server/ticket-routing.js` — `routeTicket()` helper (idempotent persist + resolve to `{member, dev_bot}`).
- `src/dashboard/views/settings-team-panel.jsx` — Settings UI panel (members table + routing table + Save).
- `tests/server/team.test.js` — DAO tests against ephemeral PG.
- `tests/server/routes-team.test.js` — route integration tests.
- `tests/server/ticket-routing.test.js` — `routeTicket()` idempotency + fallback tests.
- `tests/server/routes-tickets-route.test.js` — `POST /api/tickets/:id/route` route test.
- `tests/server/routes-dev-bots-available.test.js` — `GET /api/dev-bots/available` filter test.
- `tests/server/notify-ticket-new.test.js` — `notifyTicketNew()` formatter test (no network).

**Modified:**
- `src/server/db.js` — `ALTER TABLE tickets` to add `routed_label`, `routed_member_id`, `routed_at`; export `setRouting()` + `getRouting()` helpers.
- `src/server/routes.js` — accept `category` on `POST /api/tickets`, persist as `routed_label` when set; call `notifyTicketNew()` after `notifyTicket()`; mount routes-team; add `POST /api/tickets/:id/route`.
- `src/server/routes-dev-bots.js` — add `GET /api/dev-bots/available?project=<id>`.
- `src/server/alerts.js` — add `notifyTicketNew()` helper.
- `src/server/index.js` — mount routes-team via existing `mountRoutes()` chain.
- `src/mcp/server.js` — add `get_team_labels`, `get_team_member`, `route_ticket` tools.
- `src/react/DevPanel.jsx` — fetch labels on mount; render category dropdown when non-empty; include `category` in submission.
- `src/dashboard/views/settings-view.jsx` — register `team` section, render `<TeamPanel/>`.
- `.agents/shelly/SOUL.md` — paragraph on `[ticket-new]` reaction protocol.

---

## Task 1: Migration 006 — Postgres schema

**Files:**
- Create: `infra/migrations/006-team-routing.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- 006-team-routing.sql
-- Per-project team roster + label routing for ticket notifications.
--
-- team_members: people who can receive ticket DMs on a project. Linked to a
-- paired Telegram bot row in dev_bots; tg_user_id is denormalized so Shelly's
-- MCP doesn't have to JOIN to find the chat target.
--
-- team_routing: project-scoped {label -> member} map. The DevPanel widget
-- exposes the labels as a category dropdown; Shelly classifies into them when
-- the user doesn't pick one.

BEGIN;

CREATE TABLE IF NOT EXISTS team_members (
  id              SERIAL PRIMARY KEY,
  project_id      TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  dev_bot_id      INTEGER REFERENCES dev_bots(id),
  tg_user_id      BIGINT,
  added_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE (project_id, display_name),
  UNIQUE (project_id, dev_bot_id)
);

CREATE INDEX IF NOT EXISTS team_members_project_idx ON team_members(project_id);

CREATE TABLE IF NOT EXISTS team_routing (
  id              SERIAL PRIMARY KEY,
  project_id      TEXT NOT NULL,
  label           TEXT NOT NULL,
  member_id       INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (project_id, label)
);

CREATE INDEX IF NOT EXISTS team_routing_project_idx ON team_routing(project_id);

COMMIT;
```

- [ ] **Step 2: Apply locally to verify the file parses**

Run:
```bash
docker run --rm -i postgres:16-alpine psql --version
# verify psql is available
docker run --rm -d --name pg-team-test \
  -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t -e POSTGRES_DB=t \
  -p 127.0.0.1:15999:5432 postgres:16-alpine
sleep 5
# Apply the prerequisite (dev_bots, since 006 references it via FK)
docker exec -i pg-team-test psql -U t -d t -v ON_ERROR_STOP=1 < infra/migrations/004-dev-bots.sql
docker exec -i pg-team-test psql -U t -d t -v ON_ERROR_STOP=1 < infra/migrations/006-team-routing.sql
docker exec -i pg-team-test psql -U t -d t -tAc "SELECT count(*) FROM team_members"
docker kill pg-team-test
```
Expected: prints `0` (table exists, empty).

- [ ] **Step 3: Commit**

```bash
git add infra/migrations/006-team-routing.sql
git commit -m "feat(db): migration 006 — team_members + team_routing tables"
```

---

## Task 2: Test helper extension — apply migrations 004+006 in `_helpers/pg.js`

**Files:**
- Modify: `tests/_helpers/pg.js`

The existing helper applies only migration 003. Tests for `team.*` need 004 (`dev_bots`, FK target) and 006. Refactor to apply a list.

- [ ] **Step 1: Replace the single-migration block with a list-driven loop**

Open `tests/_helpers/pg.js`. Find the constant `MIGRATION` (line ~19) and the `startPg()` body that applies it (line ~64–73). Replace both:

```js
// before (the line declaring MIGRATION):
const MIGRATIONS = [
  resolve(__dirname, '../../infra/migrations/003-orchestration-pg.sql'),
  resolve(__dirname, '../../infra/migrations/004-dev-bots.sql'),
  resolve(__dirname, '../../infra/migrations/005-dev-bot-allowlist.sql'),
  resolve(__dirname, '../../infra/migrations/006-team-routing.sql'),
];
```

And inside `startPg()`, replace the migration-application block with:

```js
for (const path of MIGRATIONS) {
  const sql = readFileSync(path, 'utf8');
  const r = spawnSync(
    'docker',
    ['exec', '-i', containerId, 'psql', '-U', 'test', '-d', 'test', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8' }
  );
  if (r.status !== 0) {
    throw new Error(`migration ${path} failed: ${r.stderr}`);
  }
}
```

- [ ] **Step 2: Add a `truncateTeam()` helper next to `truncateOrchestration()`**

Append to `tests/_helpers/pg.js`:

```js
export async function truncateTeam() {
  if (!poolRef) throw new Error('startPg() must be called first');
  await poolRef.query(
    `TRUNCATE team_routing, team_members, dev_bot_allowlist, dev_bots RESTART IDENTITY CASCADE`
  );
}
```

- [ ] **Step 3: Run an existing PG test to confirm nothing regressed**

Run:
```bash
TEST_PG=1 npx vitest run tests/server/workflow-instances.test.js
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/_helpers/pg.js
git commit -m "test(pg-helper): apply migrations 003+004+005+006; add truncateTeam"
```

---

## Task 3: DAO — `src/server/team.js`

**Files:**
- Create: `src/server/team.js`
- Test: `tests/server/team.test.js`

- [ ] **Step 1: Write the failing test file**

Create `tests/server/team.test.js`:

```js
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startPg, stopPg, truncateTeam, getPool } from '../_helpers/pg.js';
import { insertDevBot, updateDevBotOwner } from '../../src/server/dev-bots.js';
import {
  addMember, listMembers, updateMember, deleteMember,
  setRoutingForProject, listRoutingForProject, listLabelsForProject,
  resolveLabel
} from '../../src/server/team.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('team DAO', () => {
  beforeAll(async () => { await startPg(); });
  afterAll(async () => { await stopPg(); });
  beforeEach(async () => { await truncateTeam(); });

  async function seedBot(label, owner = 1234567n) {
    const id = await insertDevBot({
      bot_token: `T-${label}`, bot_username: `${label}_bot`, bot_label: label,
      paired_by_tg_user_id: 5663177530n
    });
    await updateDevBotOwner(id, { owner_tg_user_id: owner, owner_first_name: label });
    return id;
  }

  it('addMember stores name + dev_bot_id + denormalized tg_user_id', async () => {
    const botId = await seedBot('alex', 100n);
    const m = await addMember({ project_id: 'p1', display_name: 'Alex', dev_bot_id: botId });
    expect(m.id).toBeGreaterThan(0);
    expect(m.display_name).toBe('Alex');
    expect(m.dev_bot_id).toBe(botId);
    expect(String(m.tg_user_id)).toBe('100');
  });

  it('listMembers joins dev_bot info', async () => {
    const botId = await seedBot('geronimo', 200n);
    await addMember({ project_id: 'p1', display_name: 'Geronimo', dev_bot_id: botId });
    const out = await listMembers('p1');
    expect(out).toHaveLength(1);
    expect(out[0].dev_bot.label).toBe('geronimo');
    expect(out[0].dev_bot.username).toBe('geronimo_bot');
  });

  it('addMember rejects duplicate display_name in same project', async () => {
    const a = await seedBot('a', 1n);
    const b = await seedBot('b', 2n);
    await addMember({ project_id: 'p1', display_name: 'X', dev_bot_id: a });
    await expect(addMember({ project_id: 'p1', display_name: 'X', dev_bot_id: b }))
      .rejects.toThrow();
  });

  it('addMember rejects same dev_bot twice in same project but allows reuse across projects', async () => {
    const botId = await seedBot('alex', 100n);
    await addMember({ project_id: 'p1', display_name: 'Alex', dev_bot_id: botId });
    await expect(addMember({ project_id: 'p1', display_name: 'Alice', dev_bot_id: botId }))
      .rejects.toThrow();
    const cross = await addMember({ project_id: 'p2', display_name: 'Alex', dev_bot_id: botId });
    expect(cross.id).toBeGreaterThan(0);
  });

  it('setRoutingForProject is full-replace and transactional', async () => {
    const botA = await seedBot('a', 1n);
    const botB = await seedBot('b', 2n);
    const m1 = await addMember({ project_id: 'p1', display_name: 'A', dev_bot_id: botA });
    const m2 = await addMember({ project_id: 'p1', display_name: 'B', dev_bot_id: botB });
    await setRoutingForProject('p1', [
      { label: 'pedago', member_id: m1.id },
      { label: 'com',    member_id: m2.id }
    ]);
    let out = await listRoutingForProject('p1');
    expect(out.map(r => r.label).sort()).toEqual(['com', 'pedago']);
    // Replace with a single rule.
    await setRoutingForProject('p1', [{ label: 'campus', member_id: m1.id }]);
    out = await listRoutingForProject('p1');
    expect(out.map(r => r.label)).toEqual(['campus']);
  });

  it('setRoutingForProject rejects invalid member_id atomically', async () => {
    const botA = await seedBot('a', 1n);
    const m1 = await addMember({ project_id: 'p1', display_name: 'A', dev_bot_id: botA });
    await setRoutingForProject('p1', [{ label: 'kept', member_id: m1.id }]);
    await expect(
      setRoutingForProject('p1', [
        { label: 'pedago', member_id: m1.id },
        { label: 'broken', member_id: 999999 }
      ])
    ).rejects.toThrow();
    // Original survives — transaction rolled back.
    const out = await listRoutingForProject('p1');
    expect(out.map(r => r.label)).toEqual(['kept']);
  });

  it('listLabelsForProject returns label + member_name pairs', async () => {
    const botA = await seedBot('a', 1n);
    const m = await addMember({ project_id: 'p1', display_name: 'Alex', dev_bot_id: botA });
    await setRoutingForProject('p1', [{ label: 'com', member_id: m.id }]);
    const labels = await listLabelsForProject('p1');
    expect(labels).toEqual([{ label: 'com', member_name: 'Alex' }]);
  });

  it('resolveLabel returns member with dev_bot info or null', async () => {
    const botA = await seedBot('alex', 999n);
    const m = await addMember({ project_id: 'p1', display_name: 'Alex', dev_bot_id: botA });
    await setRoutingForProject('p1', [{ label: 'com', member_id: m.id }]);
    const hit = await resolveLabel('p1', 'com');
    expect(hit.member.display_name).toBe('Alex');
    expect(hit.dev_bot.label).toBe('alex');
    expect(String(hit.member.tg_user_id)).toBe('999');
    const miss = await resolveLabel('p1', 'unknown');
    expect(miss).toBeNull();
  });

  it('deleteMember cascades into team_routing', async () => {
    const botA = await seedBot('a', 1n);
    const m = await addMember({ project_id: 'p1', display_name: 'A', dev_bot_id: botA });
    await setRoutingForProject('p1', [{ label: 'x', member_id: m.id }]);
    await deleteMember(m.id);
    expect(await listMembers('p1')).toEqual([]);
    expect(await listRoutingForProject('p1')).toEqual([]);
  });

  it('updateMember can change name and dev_bot_id; tg_user_id refreshes', async () => {
    const botA = await seedBot('a', 1n);
    const botB = await seedBot('b', 2n);
    const m = await addMember({ project_id: 'p1', display_name: 'Old', dev_bot_id: botA });
    const updated = await updateMember(m.id, { display_name: 'New', dev_bot_id: botB });
    expect(updated.display_name).toBe('New');
    expect(updated.dev_bot_id).toBe(botB);
    expect(String(updated.tg_user_id)).toBe('2');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
TEST_PG=1 npx vitest run tests/server/team.test.js
```
Expected: FAIL with `Cannot find module '../../src/server/team.js'`.

- [ ] **Step 3: Implement `src/server/team.js`**

Create `src/server/team.js`:

```js
// src/server/team.js
// Team roster + label routing per project. Tables team_members and
// team_routing live in shared Postgres (migration 006). Reads denormalize the
// dev_bot fields the callers actually need (label, username, tg_user_id) so
// the route handler / MCP / Shelly never have to JOIN themselves.

import { pool } from './pg.js';

function serializeBigInts(row) {
  if (!row) return row;
  if (row.tg_user_id != null && typeof row.tg_user_id === 'bigint') {
    row.tg_user_id = row.tg_user_id.toString();
  }
  return row;
}

export async function addMember({ project_id, display_name, dev_bot_id }) {
  // Pull tg_user_id from dev_bots so callers don't have to.
  const { rows: bots } = await pool.query(
    `SELECT owner_tg_user_id FROM dev_bots WHERE id = $1`, [dev_bot_id]
  );
  if (!bots[0]) throw new Error(`dev_bot ${dev_bot_id} not found`);
  const tg = bots[0].owner_tg_user_id;
  const { rows } = await pool.query(
    `INSERT INTO team_members (project_id, display_name, dev_bot_id, tg_user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, project_id, display_name, dev_bot_id, tg_user_id`,
    [project_id, display_name, dev_bot_id, tg]
  );
  return serializeBigInts(rows[0]);
}

export async function listMembers(project_id) {
  const { rows } = await pool.query(
    `SELECT m.id, m.project_id, m.display_name, m.dev_bot_id, m.tg_user_id,
            b.bot_label, b.bot_username, b.owner_first_name
       FROM team_members m
       LEFT JOIN dev_bots b ON b.id = m.dev_bot_id
      WHERE m.project_id = $1
      ORDER BY m.id`,
    [project_id]
  );
  return rows.map(r => ({
    id: r.id,
    project_id: r.project_id,
    display_name: r.display_name,
    dev_bot_id: r.dev_bot_id,
    tg_user_id: r.tg_user_id != null ? String(r.tg_user_id) : null,
    dev_bot: r.dev_bot_id ? {
      id: r.dev_bot_id,
      label: r.bot_label,
      username: r.bot_username,
      owner_first_name: r.owner_first_name
    } : null
  }));
}

export async function findMember(member_id) {
  const { rows } = await pool.query(
    `SELECT m.id, m.project_id, m.display_name, m.dev_bot_id, m.tg_user_id,
            b.bot_label, b.bot_username, b.owner_first_name
       FROM team_members m
       LEFT JOIN dev_bots b ON b.id = m.dev_bot_id
      WHERE m.id = $1`,
    [member_id]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id,
    project_id: r.project_id,
    display_name: r.display_name,
    dev_bot_id: r.dev_bot_id,
    tg_user_id: r.tg_user_id != null ? String(r.tg_user_id) : null,
    dev_bot: r.dev_bot_id ? {
      id: r.dev_bot_id,
      label: r.bot_label,
      username: r.bot_username,
      owner_first_name: r.owner_first_name
    } : null
  };
}

export async function updateMember(id, { display_name, dev_bot_id }) {
  // If dev_bot_id changes, refresh tg_user_id.
  let newTg = null;
  if (dev_bot_id != null) {
    const { rows: bots } = await pool.query(
      `SELECT owner_tg_user_id FROM dev_bots WHERE id = $1`, [dev_bot_id]
    );
    if (!bots[0]) throw new Error(`dev_bot ${dev_bot_id} not found`);
    newTg = bots[0].owner_tg_user_id;
  }
  const sets = [];
  const params = [];
  if (display_name != null) { params.push(display_name); sets.push(`display_name = $${params.length}`); }
  if (dev_bot_id != null)   { params.push(dev_bot_id);   sets.push(`dev_bot_id = $${params.length}`);
                              params.push(newTg);        sets.push(`tg_user_id = $${params.length}`); }
  if (sets.length === 0) return findMember(id);
  params.push(id);
  await pool.query(
    `UPDATE team_members SET ${sets.join(', ')} WHERE id = $${params.length}`,
    params
  );
  return findMember(id);
}

export async function deleteMember(id) {
  // ON DELETE CASCADE clears team_routing rows.
  await pool.query(`DELETE FROM team_members WHERE id = $1`, [id]);
}

export async function setRoutingForProject(project_id, rules) {
  // Full-replace, transactional. Validates member ownership of project.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (rules.length > 0) {
      const ids = rules.map(r => r.member_id);
      const { rows: owned } = await client.query(
        `SELECT id FROM team_members WHERE project_id = $1 AND id = ANY($2::int[])`,
        [project_id, ids]
      );
      if (owned.length !== new Set(ids).size) {
        throw new Error('one or more member_id values do not belong to this project');
      }
    }
    await client.query(`DELETE FROM team_routing WHERE project_id = $1`, [project_id]);
    for (const r of rules) {
      await client.query(
        `INSERT INTO team_routing (project_id, label, member_id) VALUES ($1, $2, $3)`,
        [project_id, r.label, r.member_id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listRoutingForProject(project_id) {
  const { rows } = await pool.query(
    `SELECT r.label, r.member_id, m.display_name AS member_name
       FROM team_routing r
       JOIN team_members m ON m.id = r.member_id
      WHERE r.project_id = $1
      ORDER BY r.label`,
    [project_id]
  );
  return rows;
}

export async function listLabelsForProject(project_id) {
  const rows = await listRoutingForProject(project_id);
  return rows.map(r => ({ label: r.label, member_name: r.member_name }));
}

export async function resolveLabel(project_id, label) {
  const { rows } = await pool.query(
    `SELECT r.label, m.id AS member_id
       FROM team_routing r
       JOIN team_members m ON m.id = r.member_id
      WHERE r.project_id = $1 AND r.label = $2`,
    [project_id, label]
  );
  if (!rows[0]) return null;
  const member = await findMember(rows[0].member_id);
  if (!member || !member.dev_bot) return null;
  return {
    member: {
      id: member.id,
      display_name: member.display_name,
      tg_user_id: member.tg_user_id
    },
    dev_bot: member.dev_bot
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
TEST_PG=1 npx vitest run tests/server/team.test.js
```
Expected: 9 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/team.js tests/server/team.test.js
git commit -m "feat(server): team DAO — members, routing, label resolution"
```

---

## Task 4: Routes — `/api/team/*` and `/api/dev-bots/available`

**Files:**
- Create: `src/server/routes-team.js`
- Test: `tests/server/routes-team.test.js`
- Modify: `src/server/routes-dev-bots.js`
- Test: `tests/server/routes-dev-bots-available.test.js`

- [ ] **Step 1: Write the failing test for `/api/team/*` routes**

Create `tests/server/routes-team.test.js`:

```js
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startPg, stopPg, truncateTeam } from '../_helpers/pg.js';
import { initMasterDatabase, createProject } from '../../src/server/db.js';
import { insertDevBot, updateDevBotOwner } from '../../src/server/dev-bots.js';
import { createApiRoutes } from '../../src/server/routes.js';
import { mountTeamRoutes } from '../../src/server/routes-team.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('routes-team', () => {
  let app, project, storage, key;
  beforeAll(async () => { await startPg(); });
  afterAll(async () => { await stopPg(); });

  beforeEach(async () => {
    await truncateTeam();
    storage = mkdtempSync(join(tmpdir(), 'devpanel-routes-team-'));
    initMasterDatabase(storage);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
    key = project.api_key;
    app = express();
    app.use(express.json());
    app.use('/api', createApiRoutes(storage));
    mountTeamRoutes(app, storage);
  });

  async function seedBot(label, owner) {
    const id = await insertDevBot({
      bot_token: `T-${label}`, bot_username: `${label}_bot`, bot_label: label,
      paired_by_tg_user_id: 5663177530n
    });
    await updateDevBotOwner(id, { owner_tg_user_id: owner, owner_first_name: label });
    return id;
  }

  it('GET /api/team is empty by default', async () => {
    const r = await supertest(app).get('/api/team').set('X-API-Key', key);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ members: [], routing: [] });
  });

  it('POST /api/team/members creates a member', async () => {
    const botId = await seedBot('alex', 100n);
    const r = await supertest(app)
      .post('/api/team/members')
      .set('X-API-Key', key)
      .send({ display_name: 'Alex', dev_bot_id: botId });
    expect(r.status).toBe(201);
    expect(r.body.display_name).toBe('Alex');
    expect(r.body.dev_bot.label).toBe('alex');
    expect(r.body.tg_user_id).toBe('100');
  });

  it('POST /api/team/members 400 if dev_bot_id is missing', async () => {
    const r = await supertest(app)
      .post('/api/team/members')
      .set('X-API-Key', key)
      .send({ display_name: 'X' });
    expect(r.status).toBe(400);
  });

  it('PUT /api/team/routing replaces transactionally', async () => {
    const botA = await seedBot('a', 1n);
    const botB = await seedBot('b', 2n);
    const ma = (await supertest(app).post('/api/team/members').set('X-API-Key', key)
                  .send({ display_name: 'A', dev_bot_id: botA })).body;
    const mb = (await supertest(app).post('/api/team/members').set('X-API-Key', key)
                  .send({ display_name: 'B', dev_bot_id: botB })).body;
    let r = await supertest(app).put('/api/team/routing').set('X-API-Key', key)
      .send([{ label: 'pedago', member_id: ma.id }, { label: 'com', member_id: mb.id }]);
    expect(r.status).toBe(200);
    r = await supertest(app).get('/api/team').set('X-API-Key', key);
    expect(r.body.routing.map(x => x.label).sort()).toEqual(['com', 'pedago']);
    // Replace with a single rule.
    r = await supertest(app).put('/api/team/routing').set('X-API-Key', key)
      .send([{ label: 'campus', member_id: ma.id }]);
    expect(r.status).toBe(200);
    r = await supertest(app).get('/api/team').set('X-API-Key', key);
    expect(r.body.routing.map(x => x.label)).toEqual(['campus']);
  });

  it('GET /api/team/labels returns label + member_name', async () => {
    const botA = await seedBot('alex', 1n);
    const ma = (await supertest(app).post('/api/team/members').set('X-API-Key', key)
                  .send({ display_name: 'Alex', dev_bot_id: botA })).body;
    await supertest(app).put('/api/team/routing').set('X-API-Key', key)
      .send([{ label: 'com', member_id: ma.id }]);
    const r = await supertest(app).get('/api/team/labels').set('X-API-Key', key);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ label: 'com', member_name: 'Alex' }]);
  });

  it('rejects without project key', async () => {
    const r = await supertest(app).get('/api/team');
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test — expect it to fail**

Run:
```bash
TEST_PG=1 npx vitest run tests/server/routes-team.test.js
```
Expected: FAIL with `Cannot find module '../../src/server/routes-team.js'`.

- [ ] **Step 3: Implement `src/server/routes-team.js`**

Create `src/server/routes-team.js`:

```js
// src/server/routes-team.js
// Per-project team & routing API. All routes use the project's X-API-Key
// (same auth as /api/tickets) — the widget already ships that key in its
// bundle, so /labels is consistent with the rest of the widget surface.

import express from 'express';
import {
  addMember, listMembers, updateMember, deleteMember,
  setRoutingForProject, listRoutingForProject, listLabelsForProject
} from './team.js';

export function mountTeamRoutes(app, _storagePath) {
  const router = express.Router();

  // authenticateProject middleware lives in routes.js — we re-import the
  // factory style by re-mounting under a router that the caller already has
  // auth applied to. To keep coupling low, we read req.project that
  // authenticateProject sets; the caller (routes.js) ensures auth is upstream
  // by mounting via app.use('/api/team', authenticateProject, router).
  router.get('/', async (req, res) => {
    try {
      const [members, routing] = await Promise.all([
        listMembers(req.project.id),
        listRoutingForProject(req.project.id)
      ]);
      res.json({ members, routing });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/labels', async (req, res) => {
    try {
      const labels = await listLabelsForProject(req.project.id);
      res.json(labels);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/routing', async (req, res) => {
    try {
      const routing = await listRoutingForProject(req.project.id);
      res.json(routing);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/routing', async (req, res) => {
    const rules = Array.isArray(req.body) ? req.body : [];
    if (rules.some(r => !r || typeof r.label !== 'string' || typeof r.member_id !== 'number')) {
      return res.status(400).json({ error: 'expected [{label, member_id}, ...]' });
    }
    try {
      await setRoutingForProject(req.project.id, rules);
      const out = await listRoutingForProject(req.project.id);
      res.json(out);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/members', async (req, res) => {
    const { display_name, dev_bot_id } = req.body ?? {};
    if (!display_name || !dev_bot_id) {
      return res.status(400).json({ error: 'display_name and dev_bot_id required' });
    }
    try {
      const m = await addMember({ project_id: req.project.id, display_name, dev_bot_id });
      // Re-fetch to include dev_bot info in the response.
      const list = await listMembers(req.project.id);
      const full = list.find(x => x.id === m.id);
      res.status(201).json(full);
    } catch (err) {
      if (/duplicate|unique/i.test(err.message)) {
        return res.status(409).json({ error: err.message });
      }
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/members/:id', async (req, res) => {
    const { display_name, dev_bot_id } = req.body ?? {};
    try {
      const m = await updateMember(parseInt(req.params.id, 10), { display_name, dev_bot_id });
      res.json(m);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/members/:id', async (req, res) => {
    await deleteMember(parseInt(req.params.id, 10));
    res.status(204).end();
  });

  // The caller wires authenticateProject upstream — see routes.js.
  app.use('/api/team', router);
}
```

- [ ] **Step 4: Wire mount-with-auth in `src/server/routes.js`**

Open `src/server/routes.js`. Locate the spot where `mountDevBotsRoutes(app)` is called (search for `mountDevBotsRoutes` — there may be one in `src/server/index.js` instead; if so apply the change there). Add immediately after, in the same file:

```js
import { mountTeamRoutes } from './routes-team.js';
// ...later, near the existing mountDevBotsRoutes(app):
mountTeamRoutes(app, storagePath);
```

But `mountTeamRoutes` needs `authenticateProject` upstream. The simpler wiring: instead of mounting at the app level, expose a `createTeamRouter()` and let `routes.js` mount it under the existing `router` that already has per-route `authenticateProject`. Replace the bottom of `src/server/routes-team.js`:

```js
// Replace `app.use('/api/team', router);` with an export of the router and
// have caller apply authenticateProject as middleware.
export function createTeamRouter() { return router; }
```

And change the export at the top so the function `mountTeamRoutes` becomes `createTeamRouter`:

```js
export function createTeamRouter() {
  const router = express.Router();
  // ...all the route handlers above...
  return router;
}
```

(Refactor the file: keep the handler bodies identical; wrap them in `createTeamRouter()` returning the router; no `app.use` call inside the module.)

Then in `src/server/routes.js`, near the end of `createApiRoutes(storagePath)` where the main router is built, add:

```js
import { createTeamRouter } from './routes-team.js';
// ...inside createApiRoutes, after other routes are mounted on `router`:
router.use('/team', authenticateProject, createTeamRouter());
```

If `createApiRoutes` doesn't export a single composed router, mount on `app` instead from `index.js` — pick whichever pattern the existing `dev-bots` routes use (read `src/server/index.js` and mirror it).

- [ ] **Step 5: Verify the test imports compile**

Update the test imports in `tests/server/routes-team.test.js`:

```js
// Replace
import { mountTeamRoutes } from '../../src/server/routes-team.js';
// With
import { createTeamRouter } from '../../src/server/routes-team.js';
```

And update the `beforeEach` block to mount under the project router pattern. The exact pattern depends on what `createApiRoutes` returns; if it returns a router that already wires `authenticateProject`, the test's `app.use('/api', createApiRoutes(storage))` is enough — `team` routes get added inside `createApiRoutes`.

If `createApiRoutes` does NOT mount team routes when called, the test should add them itself with the same auth helper. Read `src/server/routes.js` to find the exported `authenticateProject` function and import it in the test:

```js
import { authenticateProject } from '../../src/server/middleware/auth.js'; // adjust path if needed
// In beforeEach:
app.use('/api/team', (req, res, next) => { req.storagePath = storage; next(); }, authenticateProject, createTeamRouter());
```

Pick whichever wiring matches the existing codebase pattern.

- [ ] **Step 6: Run tests**

Run:
```bash
TEST_PG=1 npx vitest run tests/server/routes-team.test.js
```
Expected: 6 PASS.

- [ ] **Step 7: Add `GET /api/dev-bots/available` test**

Create `tests/server/routes-dev-bots-available.test.js`:

```js
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { startPg, stopPg, truncateTeam } from '../_helpers/pg.js';
import { insertDevBot, updateDevBotOwner } from '../../src/server/dev-bots.js';
import { addMember } from '../../src/server/team.js';
import { mountDevBotsRoutes } from '../../src/server/routes-dev-bots.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('GET /api/dev-bots/available', () => {
  let app;
  beforeAll(async () => { await startPg(); });
  afterAll(async () => { await stopPg(); });

  beforeEach(async () => {
    await truncateTeam();
    app = express();
    app.use(express.json());
    mountDevBotsRoutes(app);
  });

  it('returns active bots not yet linked to a member of the project', async () => {
    const a = await insertDevBot({
      bot_token: 'TA', bot_username: 'a_bot', bot_label: 'a',
      paired_by_tg_user_id: 1n
    });
    await updateDevBotOwner(a, { owner_tg_user_id: 100n, owner_first_name: 'A' });
    const b = await insertDevBot({
      bot_token: 'TB', bot_username: 'b_bot', bot_label: 'b',
      paired_by_tg_user_id: 1n
    });
    await updateDevBotOwner(b, { owner_tg_user_id: 200n, owner_first_name: 'B' });
    // Link `a` to a member of project p1; `b` should remain available.
    await addMember({ project_id: 'p1', display_name: 'A-member', dev_bot_id: a });
    const r = await supertest(app).get('/api/dev-bots/available?project=p1');
    expect(r.status).toBe(200);
    expect(r.body.map(x => x.bot_label)).toEqual(['b']);
    // For p2 (where neither bot is linked), both should be available.
    const r2 = await supertest(app).get('/api/dev-bots/available?project=p2');
    expect(r2.body.map(x => x.bot_label).sort()).toEqual(['a', 'b']);
  });

  it('400 if project query is missing', async () => {
    const r = await supertest(app).get('/api/dev-bots/available');
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 8: Implement `/available` in `src/server/routes-dev-bots.js`**

Open `src/server/routes-dev-bots.js`. Inside `mountDevBotsRoutes(app)`, before `app.use('/api/dev-bots', router)`, add:

```js
router.get('/available', async (req, res) => {
  const project = req.query.project;
  if (!project) return res.status(400).json({ error: 'project query param required' });
  const { rows } = await (await import('./pg.js')).pool.query(
    `SELECT b.id, b.bot_label, b.bot_username, b.owner_first_name
       FROM dev_bots b
      WHERE b.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM team_members m
           WHERE m.project_id = $1 AND m.dev_bot_id = b.id
        )
      ORDER BY b.id`,
    [project]
  );
  res.json(rows);
});
```

(If the existing file already imports `pool` at the top, use that import directly.)

- [ ] **Step 9: Run tests**

Run:
```bash
TEST_PG=1 npx vitest run tests/server/routes-dev-bots-available.test.js
```
Expected: 2 PASS.

- [ ] **Step 10: Commit**

```bash
git add src/server/routes-team.js src/server/routes-dev-bots.js src/server/routes.js \
        tests/server/routes-team.test.js tests/server/routes-dev-bots-available.test.js
git commit -m "feat(server): /api/team CRUD + /api/dev-bots/available filter"
```

---

## Task 5: Tickets schema — `routed_label`, `routed_member_id`, `routed_at`

**Files:**
- Modify: `src/server/db.js`
- Test: `tests/server/db-schema.test.js` (add a sub-test, don't replace existing ones)

- [ ] **Step 1: Read the existing schema migration pattern**

Open `src/server/db.js`. Find `initProjectDatabase` (line ~289). Note the existing `ALTER TABLE` pattern using `PRAGMA table_info` (similar to lines ~46–60 for the master DB).

- [ ] **Step 2: Write a test that asserts the columns exist**

Open `tests/server/db-schema.test.js` (existing file). Add at the end of the existing `describe(...)`:

```js
it('per-project tickets table has routed_label, routed_member_id, routed_at', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'devpanel-routed-cols-'));
  initMasterDatabase(tmp);
  const proj = createProject({ name: 'p', github_owner: 'o', github_repo: 'r' });
  initProjectDatabase(tmp, proj.id);
  const Database = require('better-sqlite3');
  const raw = new Database(join(tmp, proj.id, 'tickets.db'));
  const cols = raw.prepare("PRAGMA table_info(tickets)").all().map(c => c.name);
  expect(cols).toContain('routed_label');
  expect(cols).toContain('routed_member_id');
  expect(cols).toContain('routed_at');
  raw.close();
});
```

(Adapt imports at the file's top if missing: `mkdtempSync`, `tmpdir`, `join`, `initMasterDatabase`, `initProjectDatabase`, `createProject`.)

- [ ] **Step 3: Run the test — expect it to fail**

Run:
```bash
npx vitest run tests/server/db-schema.test.js
```
Expected: FAIL — `cols` doesn't contain `routed_label`.

- [ ] **Step 4: Add the migration**

In `src/server/db.js`, inside `initProjectDatabase`, after the `tickets` `CREATE TABLE IF NOT EXISTS` block (around line ~334) and before the indexes, add:

```js
// Routing fields populated by Shelly when a ticket is dispatched to a team
// member. routed_label is also written immediately at submission time when
// the widget user picks a category.
const ticketCols = new Set(
  db.prepare("PRAGMA table_info(tickets)").all().map(c => c.name)
);
for (const [col, def] of [
  ['routed_label',     'TEXT'],
  ['routed_member_id', 'INTEGER'],
  ['routed_at',        'DATETIME']
]) {
  if (!ticketCols.has(col)) {
    db.exec(`ALTER TABLE tickets ADD COLUMN ${col} ${def}`);
  }
}
```

- [ ] **Step 5: Add `setRouting` and `getRouting` helpers**

Append to `src/server/db.js` near the other ticket helpers (after `updateTicket`, around line ~600):

```js
export function setTicketRouting(storagePath, projectId, ticketId, { label, member_id }) {
  const db = initProjectDatabase(storagePath, projectId);
  db.prepare(
    `UPDATE tickets SET routed_label = ?, routed_member_id = ?, routed_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(label, member_id, ticketId);
}

export function getTicketRouting(storagePath, projectId, ticketId) {
  const db = initProjectDatabase(storagePath, projectId);
  const row = db.prepare(
    `SELECT routed_label, routed_member_id, routed_at FROM tickets WHERE id = ?`
  ).get(ticketId);
  return row ?? null;
}
```

- [ ] **Step 6: Run the schema test**

Run:
```bash
npx vitest run tests/server/db-schema.test.js
```
Expected: all PASS including the new sub-test.

- [ ] **Step 7: Commit**

```bash
git add src/server/db.js tests/server/db-schema.test.js
git commit -m "feat(db): tickets.routed_label/routed_member_id/routed_at + helpers"
```

---

## Task 6: `routeTicket()` helper + `POST /api/tickets/:id/route`

**Files:**
- Create: `src/server/ticket-routing.js`
- Test: `tests/server/ticket-routing.test.js`
- Test: `tests/server/routes-tickets-route.test.js`
- Modify: `src/server/routes.js`

- [ ] **Step 1: Write the failing test for `routeTicket()`**

Create `tests/server/ticket-routing.test.js`:

```js
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startPg, stopPg, truncateTeam } from '../_helpers/pg.js';
import { initMasterDatabase, createProject, initProjectDatabase, createTicket }
  from '../../src/server/db.js';
import { insertDevBot, updateDevBotOwner } from '../../src/server/dev-bots.js';
import { addMember, setRoutingForProject } from '../../src/server/team.js';
import { routeTicket } from '../../src/server/ticket-routing.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('routeTicket', () => {
  let storage, project, member, botId;
  beforeAll(async () => { await startPg(); });
  afterAll(async () => { await stopPg(); });

  beforeEach(async () => {
    await truncateTeam();
    storage = mkdtempSync(join(tmpdir(), 'devpanel-routeticket-'));
    initMasterDatabase(storage);
    project = createProject({ name: 'p', github_owner: 'o', github_repo: 'r' });
    initProjectDatabase(storage, project.id);
    botId = await insertDevBot({
      bot_token: 'T', bot_username: 'alex_bot', bot_label: 'alex',
      paired_by_tg_user_id: 1n
    });
    await updateDevBotOwner(botId, { owner_tg_user_id: 999n, owner_first_name: 'Alex' });
    member = await addMember({ project_id: project.id, display_name: 'Alex', dev_bot_id: botId });
    await setRoutingForProject(project.id, [{ label: 'com', member_id: member.id }]);
  });

  it('persists routing and returns member + dev_bot', async () => {
    const ticketId = createTicket(storage, project.id, {
      type: 'bug', title: 't', description: 'd'
    });
    const out = await routeTicket(storage, project.id, ticketId, 'com');
    expect(out.already_routed).toBe(false);
    expect(out.member.id).toBe(member.id);
    expect(out.dev_bot.label).toBe('alex');
    expect(String(out.dev_bot.tg_user_id)).toBe('999');
  });

  it('is idempotent — second call returns already_routed=true and ignores new label', async () => {
    const ticketId = createTicket(storage, project.id, {
      type: 'bug', title: 't', description: 'd'
    });
    await routeTicket(storage, project.id, ticketId, 'com');
    // Add a second routing for kicks.
    const bot2 = await insertDevBot({
      bot_token: 'T2', bot_username: 'b_bot', bot_label: 'b',
      paired_by_tg_user_id: 1n
    });
    const m2 = await addMember({ project_id: project.id, display_name: 'B', dev_bot_id: bot2 });
    await setRoutingForProject(project.id, [
      { label: 'com', member_id: member.id },
      { label: 'campus', member_id: m2.id }
    ]);
    const second = await routeTicket(storage, project.id, ticketId, 'campus');
    expect(second.already_routed).toBe(true);
    expect(second.label).toBe('com');
    expect(second.member.id).toBe(member.id);
  });

  it('returns null when label has no member', async () => {
    const ticketId = createTicket(storage, project.id, {
      type: 'bug', title: 't', description: 'd'
    });
    const out = await routeTicket(storage, project.id, ticketId, 'unknown');
    expect(out).toBeNull();
  });

  it('throws when ticket does not exist', async () => {
    await expect(routeTicket(storage, project.id, 99999, 'com')).rejects.toThrow();
  });

  it('honours pre-written routed_label (widget category wins over Shelly arg)', async () => {
    const ticketId = createTicket(storage, project.id, {
      type: 'bug', title: 't', description: 'd'
    });
    // Simulate widget pre-write at submission time.
    const { setTicketRouting } = await import('../../src/server/db.js');
    setTicketRouting(storage, project.id, ticketId, { label: 'com', member_id: null });
    // Shelly proposes a different label; the widget choice should win.
    const out = await routeTicket(storage, project.id, ticketId, 'campus');
    expect(out.label).toBe('com');
    expect(out.already_routed).toBe(false);
    expect(out.member.id).toBe(member.id);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run:
```bash
TEST_PG=1 npx vitest run tests/server/ticket-routing.test.js
```
Expected: FAIL with `Cannot find module '../../src/server/ticket-routing.js'`.

- [ ] **Step 3: Implement `src/server/ticket-routing.js`**

```js
// src/server/ticket-routing.js
// Idempotent: if a ticket already has routed_label, returns the existing
// routing without changing it. This protects against duplicate [ticket-new]
// fires (deploy churn, Shelly retry) — Shelly checks already_routed and
// skips the DM in that case.

import { getTicket, setTicketRouting, getTicketRouting } from './db.js';
import { resolveLabel, findMember } from './team.js';

export async function routeTicket(storagePath, projectId, ticketId, label) {
  const ticket = getTicket(storagePath, projectId, ticketId);
  if (!ticket) throw new Error(`ticket ${ticketId} not found`);

  // Idempotency: a ticket is "routed" only once it has BOTH a label AND a
  // member id. The widget can pre-write routed_label at submission time when
  // the user picks a category (Task 7); that's not yet a routing decision —
  // Shelly still has to resolve the label to a member and DM them.
  const prior = getTicketRouting(storagePath, projectId, ticketId);
  if (prior && prior.routed_label && prior.routed_member_id) {
    const member = await findMember(prior.routed_member_id);
    if (!member || !member.dev_bot) return null;
    return {
      ticket_id: ticketId,
      label: prior.routed_label,
      member: {
        id: member.id,
        name: member.display_name,
        tg_user_id: member.tg_user_id
      },
      dev_bot: {
        label: member.dev_bot.label,
        username: member.dev_bot.username,
        tg_user_id: member.tg_user_id
      },
      already_routed: true
    };
  }

  // If the widget pre-wrote routed_label (user picked a category), that
  // wins over whatever Shelly proposed.
  const effectiveLabel = (prior && prior.routed_label) ? prior.routed_label : label;

  const resolved = await resolveLabel(projectId, effectiveLabel);
  if (!resolved) return null;

  setTicketRouting(storagePath, projectId, ticketId, {
    label: effectiveLabel,
    member_id: resolved.member.id
  });

  return {
    ticket_id: ticketId,
    label,
    member: {
      id: resolved.member.id,
      name: resolved.member.display_name,
      tg_user_id: resolved.member.tg_user_id
    },
    dev_bot: {
      label: resolved.dev_bot.label,
      username: resolved.dev_bot.username,
      tg_user_id: resolved.member.tg_user_id
    },
    already_routed: false
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run:
```bash
TEST_PG=1 npx vitest run tests/server/ticket-routing.test.js
```
Expected: 4 PASS.

- [ ] **Step 5: Write the route test**

Create `tests/server/routes-tickets-route.test.js`:

```js
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startPg, stopPg, truncateTeam } from '../_helpers/pg.js';
import { initMasterDatabase, createProject, initProjectDatabase, createTicket }
  from '../../src/server/db.js';
import { insertDevBot, updateDevBotOwner } from '../../src/server/dev-bots.js';
import { addMember, setRoutingForProject } from '../../src/server/team.js';
import { createApiRoutes } from '../../src/server/routes.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('POST /api/tickets/:id/route', () => {
  let app, storage, project, key, ticketId;
  beforeAll(async () => { await startPg(); });
  afterAll(async () => { await stopPg(); });

  beforeEach(async () => {
    await truncateTeam();
    storage = mkdtempSync(join(tmpdir(), 'devpanel-route-route-'));
    initMasterDatabase(storage);
    project = createProject({ name: 'p', github_owner: 'o', github_repo: 'r' });
    key = project.api_key;
    initProjectDatabase(storage, project.id);
    const botId = await insertDevBot({
      bot_token: 'T', bot_username: 'alex_bot', bot_label: 'alex',
      paired_by_tg_user_id: 1n
    });
    await updateDevBotOwner(botId, { owner_tg_user_id: 999n, owner_first_name: 'Alex' });
    const m = await addMember({ project_id: project.id, display_name: 'Alex', dev_bot_id: botId });
    await setRoutingForProject(project.id, [{ label: 'com', member_id: m.id }]);
    ticketId = createTicket(storage, project.id, {
      type: 'bug', title: 't', description: 'd'
    });
    app = express();
    app.use(express.json());
    app.use('/api', createApiRoutes(storage));
  });

  it('routes a ticket and returns member + dev_bot', async () => {
    const r = await supertest(app)
      .post(`/api/tickets/${ticketId}/route`)
      .set('X-API-Key', key)
      .send({ label: 'com' });
    expect(r.status).toBe(200);
    expect(r.body.already_routed).toBe(false);
    expect(r.body.dev_bot.label).toBe('alex');
  });

  it('is idempotent', async () => {
    await supertest(app).post(`/api/tickets/${ticketId}/route`).set('X-API-Key', key).send({ label: 'com' });
    const r = await supertest(app).post(`/api/tickets/${ticketId}/route`).set('X-API-Key', key).send({ label: 'com' });
    expect(r.body.already_routed).toBe(true);
  });

  it('409 when label has no member', async () => {
    const r = await supertest(app).post(`/api/tickets/${ticketId}/route`).set('X-API-Key', key).send({ label: 'nope' });
    expect(r.status).toBe(409);
  });

  it('404 when ticket does not exist', async () => {
    const r = await supertest(app).post('/api/tickets/99999/route').set('X-API-Key', key).send({ label: 'com' });
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 6: Run — expect FAIL (route doesn't exist yet)**

Run:
```bash
TEST_PG=1 npx vitest run tests/server/routes-tickets-route.test.js
```
Expected: FAIL — POST returns 404 from express default router.

- [ ] **Step 7: Add the route in `src/server/routes.js`**

In `src/server/routes.js`, near the existing `POST /tickets/:id/answer` (line ~1139), add:

```js
import { routeTicket } from './ticket-routing.js';

// (then inside createApiRoutes, near the other ticket POST routes:)
router.post('/tickets/:id/route', authenticateProject, async (req, res) => {
  const { label } = req.body ?? {};
  if (!label) return res.status(400).json({ error: 'label required' });
  try {
    const out = await routeTicket(storagePath, req.project.id, parseInt(req.params.id, 10), label);
    if (out === null) {
      // Distinguish "ticket missing" from "label unrouted" — the helper throws
      // for missing tickets, so null here always means no routing for label.
      return res.status(409).json({ error: `no member registered for label "${label}"` });
    }
    res.json(out);
  } catch (err) {
    if (/not found/i.test(err.message)) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 8: Run tests — expect PASS**

Run:
```bash
TEST_PG=1 npx vitest run tests/server/routes-tickets-route.test.js
```
Expected: 4 PASS.

- [ ] **Step 9: Commit**

```bash
git add src/server/ticket-routing.js src/server/routes.js \
        tests/server/ticket-routing.test.js tests/server/routes-tickets-route.test.js
git commit -m "feat(server): routeTicket helper + POST /api/tickets/:id/route"
```

---

## Task 7: `notifyTicketNew()` and emit on `POST /api/tickets`

**Files:**
- Modify: `src/server/alerts.js`
- Modify: `src/server/routes.js`
- Test: `tests/server/notify-ticket-new.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/server/notify-ticket-new.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notifyTicketNew, formatTicketNewLine } from '../../src/server/alerts.js';

describe('formatTicketNewLine', () => {
  it('formats a single line with empty category', () => {
    expect(
      formatTicketNewLine({ project: 'Zeno', ticket_id: 42, category: null,
        title: 'Login button broken on mobile' })
    ).toBe('[ticket-new] project=Zeno ticket=42 category= title="Login button broken on mobile"');
  });
  it('truncates title to 100 chars and strips newlines', () => {
    const long = 'x'.repeat(150).replace(/x/g, 'A');
    const noNL = 'A\nB\nC';
    const out = formatTicketNewLine({ project: 'p', ticket_id: 1, category: 'com', title: long });
    expect(out).toMatch(/^\[ticket-new\] project=p ticket=1 category=com title="A{100}"$/);
    const out2 = formatTicketNewLine({ project: 'p', ticket_id: 1, category: '', title: noNL });
    expect(out2).toBe('[ticket-new] project=p ticket=1 category= title="A B C"');
  });
});

describe('notifyTicketNew', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    process.env.TELEGRAM_CHAT_ID = '123';
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  });
  it('calls Telegram with the formatted line', async () => {
    await notifyTicketNew({ project: 'Zeno', ticket_id: 42, category: '', title: 'X' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, init] = global.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.text).toContain('[ticket-new] project=Zeno');
  });
  it('no-ops when no destination configured', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await notifyTicketNew({ project: 'p', ticket_id: 1, category: '', title: 't' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run:
```bash
npx vitest run tests/server/notify-ticket-new.test.js
```
Expected: FAIL — exports don't exist.

- [ ] **Step 3: Implement in `src/server/alerts.js`**

Append to `src/server/alerts.js`:

```js
// notifyTicketNew — emit a [ticket-new] system line into Shelly's channel
// when the widget creates a ticket. Shelly's SOUL has the protocol on the
// other side: read this line, classify (or trust the category), call
// route_ticket, DM the resolved member.
//
// This deliberately uses the same _hasDestination + _sendText path as
// notifyJob — push-only, no polling, never throws.
export function formatTicketNewLine({ project, ticket_id, category, title }) {
  const cat = category || '';
  const cleanTitle = String(title || '')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 100);
  return `[ticket-new] project=${project} ticket=${ticket_id} category=${cat} title="${cleanTitle}"`;
}

export async function notifyTicketNew({ project, ticket_id, category, title }) {
  if (!_hasDestination()) return;
  const line = formatTicketNewLine({ project, ticket_id, category, title });
  return _sendText(line);
}
```

- [ ] **Step 4: Run unit tests — expect PASS**

Run:
```bash
npx vitest run tests/server/notify-ticket-new.test.js
```
Expected: 4 PASS.

- [ ] **Step 5: Wire into `POST /api/tickets`**

In `src/server/routes.js`, find the `POST /tickets` handler (line ~1218). Replace the `const { type, title, description, context, screenshot, created_by } = req.body;` line with:

```js
const { type, title, description, context, screenshot, created_by, category } = req.body;
```

After the existing `notifyTicket(...)` call (line ~1259), add:

```js
// If the user picked a category in the widget, persist it as routed_label up
// front. Shelly will skip classification and call route_ticket directly.
if (category) {
  setTicketRouting(storagePath, req.project.id, ticketId, { label: category, member_id: null });
}

notifyTicketNew({
  project: req.project.name,
  ticket_id: ticketId,
  category: category || '',
  title
});
```

And at the top of `src/server/routes.js`, add the imports:

```js
import { notifyTicket, notifyTicketNew } from './alerts.js';
import { setTicketRouting } from './db.js';
```

(`setTicketRouting` accepts `member_id: null`. Make sure the helper from Task 5 doesn't reject null member_id — it doesn't, the column is nullable.)

- [ ] **Step 6: Smoke test the wiring with an existing route test**

Run:
```bash
npx vitest run tests/server/routes.test.js 2>&1 | tail -40
```
Expected: PASS (or unrelated failures — just confirm no new regression).

- [ ] **Step 7: Commit**

```bash
git add src/server/alerts.js src/server/routes.js tests/server/notify-ticket-new.test.js
git commit -m "feat(server): notifyTicketNew + emit on POST /api/tickets"
```

---

## Task 8: MCP tools — `get_team_labels`, `get_team_member`, `route_ticket`

**Files:**
- Modify: `src/mcp/server.js`

(No automated tests for the MCP layer — these are thin HTTP wrappers using the existing `projectFetch` helper, exercised by Shelly in the smoke step at Task 12.)

- [ ] **Step 1: Add `get_team_labels`**

In `src/mcp/server.js`, after the existing `get_context` tool (around line ~217), add:

```js
server.tool(
  'get_team_labels',
  'List the routing labels defined on a project (used by Shelly to classify a new ticket).',
  { project: z.string().describe('Project name') },
  async ({ project }) => {
    try {
      const proj = await resolveProjectByName(project);
      if (!proj) return { content: [{ type: 'text', text: `Project "${project}" not found` }], isError: true };
      const r = await projectFetch(proj, '/team/labels');
      if (!r.ok) return { content: [{ type: 'text', text: `GET /api/team/labels → ${r.status}: ${JSON.stringify(r.data)}` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `get_team_labels failed: ${err.message}` }], isError: true };
    }
  }
);
```

- [ ] **Step 2: Add `get_team_member`**

Below `get_team_labels`:

```js
server.tool(
  'get_team_member',
  'Get a team member by id, including their paired Telegram bot info.',
  {
    project: z.string().describe('Project name'),
    member_id: z.number().describe('team_members.id')
  },
  async ({ project, member_id }) => {
    try {
      const proj = await resolveProjectByName(project);
      if (!proj) return { content: [{ type: 'text', text: `Project "${project}" not found` }], isError: true };
      const r = await projectFetch(proj, '/team');
      if (!r.ok) return { content: [{ type: 'text', text: `GET /api/team → ${r.status}: ${JSON.stringify(r.data)}` }], isError: true };
      const member = (r.data?.members ?? []).find(m => m.id === member_id);
      if (!member) return { content: [{ type: 'text', text: `member ${member_id} not found in project "${project}"` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(member, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `get_team_member failed: ${err.message}` }], isError: true };
    }
  }
);
```

- [ ] **Step 3: Add `route_ticket`**

Below `get_team_member`:

```js
server.tool(
  'route_ticket',
  'Persist routing for a ticket and return the resolved team member + dev_bot. Idempotent: if the ticket is already routed, returns the existing routing with already_routed=true and ignores the new label.',
  {
    project: z.string().describe('Project name'),
    ticket_id: z.number().describe('Ticket numeric id'),
    label: z.string().describe('Routing label (e.g. "com", "pedago")')
  },
  async ({ project, ticket_id, label }) => {
    try {
      const proj = await resolveProjectByName(project);
      if (!proj) return { content: [{ type: 'text', text: `Project "${project}" not found` }], isError: true };
      const r = await projectFetch(proj, `/tickets/${ticket_id}/route`, {
        method: 'POST',
        body: JSON.stringify({ label })
      });
      if (!r.ok) return { content: [{ type: 'text', text: `POST /api/tickets/${ticket_id}/route → ${r.status}: ${JSON.stringify(r.data)}` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `route_ticket failed: ${err.message}` }], isError: true };
    }
  }
);
```

- [ ] **Step 4: Smoke-test the MCP via JSON-RPC locally (optional but nice)**

Run:
```bash
node --check src/mcp/server.js
```
Expected: no output (clean parse).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.js
git commit -m "feat(mcp): get_team_labels, get_team_member, route_ticket tools"
```

---

## Task 9: Widget — category dropdown

**Files:**
- Modify: `src/react/DevPanel.jsx`

- [ ] **Step 1: Read the current widget structure**

Open `src/react/DevPanel.jsx`. Locate where the form fields are rendered (the `type` selector — bug/feature — and the title input). Note the prop that exposes the project's `apiKey` and `apiUrl`.

- [ ] **Step 2: Add labels fetch + category state**

Near the top of the component:

```jsx
const [labels, setLabels] = useState([]);
const [category, setCategory] = useState('');

useEffect(() => {
  if (!apiKey || !apiUrl) return;
  let cancelled = false;
  fetch(`${apiUrl}/api/team/labels`, { headers: { 'X-API-Key': apiKey } })
    .then(r => r.ok ? r.json() : [])
    .then(data => { if (!cancelled) setLabels(Array.isArray(data) ? data : []); })
    .catch(() => { /* widget keeps working without categories */ });
  return () => { cancelled = true; };
}, [apiKey, apiUrl]);
```

- [ ] **Step 3: Render the dropdown**

Find the form JSX. After the existing type selector (`bug` / `feature`), add:

```jsx
{labels.length > 0 && (
  <label className="dp-field">
    <span>Catégorie</span>
    <select value={category} onChange={e => setCategory(e.target.value)}>
      <option value="">— Auto (Shelly choisit) —</option>
      {labels.map(l => (
        <option key={l.label} value={l.label}>
          {l.label}{l.member_name ? ` (${l.member_name})` : ''}
        </option>
      ))}
    </select>
  </label>
)}
```

- [ ] **Step 4: Include category in the submit body**

Find the `fetch(`${apiUrl}/api/tickets`, { method: 'POST', ... })` call. In the JSON body, add `category: category || undefined,` next to `type`, `title`, etc.

- [ ] **Step 5: Build the widget bundle to make sure JSX still compiles**

Run:
```bash
npm run build:widget 2>&1 | tail -20
```
Expected: build success, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/react/DevPanel.jsx dist/widget.js
git commit -m "feat(widget): optional category dropdown from /api/team/labels"
```

---

## Task 10: Settings UI — Team panel

**Files:**
- Create: `src/dashboard/views/settings-team-panel.jsx`
- Modify: `src/dashboard/views/settings-view.jsx`

- [ ] **Step 1: Read the existing settings view structure**

Open `src/dashboard/views/settings-view.jsx`. Confirm `SECTIONS` array and the panel-rendering switch.

- [ ] **Step 2: Create `settings-team-panel.jsx`**

Create `src/dashboard/views/settings-team-panel.jsx`:

```jsx
// src/dashboard/views/settings-team-panel.jsx
// Two stacked tables: members + routing. Members managed inline (add via
// inline form, delete via row button). Routing kept in a draft state until
// "Save routing" fires PUT /api/team/routing as a full replace.
import { useEffect, useState } from 'react';

export default function TeamPanel({ project, apiKey, apiBase }) {
  const [members, setMembers] = useState([]);
  const [routing, setRouting] = useState([]);          // canonical from server
  const [draftRouting, setDraftRouting] = useState([]); // editable copy
  const [availableBots, setAvailableBots] = useState([]);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newBotId, setNewBotId] = useState('');
  const [savingRouting, setSavingRouting] = useState(false);
  const [error, setError] = useState(null);

  const headers = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };

  async function loadAll() {
    const [teamRes, botsRes] = await Promise.all([
      fetch(`${apiBase}/api/team`, { headers }),
      fetch(`${apiBase}/api/dev-bots/available?project=${encodeURIComponent(project.id)}`, { headers })
    ]);
    if (teamRes.ok) {
      const t = await teamRes.json();
      setMembers(t.members);
      setRouting(t.routing);
      setDraftRouting(t.routing);
    }
    if (botsRes.ok) setAvailableBots(await botsRes.json());
  }

  useEffect(() => { loadAll(); }, [project.id]);

  async function addMemberAction() {
    setError(null);
    const r = await fetch(`${apiBase}/api/team/members`, {
      method: 'POST', headers,
      body: JSON.stringify({ display_name: newName, dev_bot_id: parseInt(newBotId, 10) })
    });
    if (!r.ok) { setError((await r.json()).error || `HTTP ${r.status}`); return; }
    setNewName(''); setNewBotId(''); setAdding(false);
    await loadAll();
  }

  async function deleteMemberAction(id) {
    if (!confirm('Remove this member? Routing rules pointing to them will be removed too.')) return;
    await fetch(`${apiBase}/api/team/members/${id}`, { method: 'DELETE', headers });
    await loadAll();
  }

  async function saveRouting() {
    setSavingRouting(true);
    setError(null);
    const payload = draftRouting
      .filter(r => r.label && r.member_id)
      .map(r => ({ label: r.label, member_id: r.member_id }));
    const r = await fetch(`${apiBase}/api/team/routing`, {
      method: 'PUT', headers, body: JSON.stringify(payload)
    });
    if (!r.ok) {
      setError((await r.json()).error || `HTTP ${r.status}`);
    } else {
      const fresh = await r.json();
      setRouting(fresh);
      setDraftRouting(fresh);
    }
    setSavingRouting(false);
  }

  function addEmptyRule() {
    setDraftRouting(prev => [...prev, { label: '', member_id: null }]);
  }

  function setRuleLabel(idx, label) {
    setDraftRouting(prev => prev.map((r, i) => i === idx ? { ...r, label } : r));
  }

  function setRuleMember(idx, member_id) {
    setDraftRouting(prev => prev.map((r, i) => i === idx ? { ...r, member_id: parseInt(member_id, 10) } : r));
  }

  function removeRule(idx) {
    setDraftRouting(prev => prev.filter((_, i) => i !== idx));
  }

  const dirty = JSON.stringify(draftRouting) !== JSON.stringify(routing);

  return (
    <div className="flex flex-col gap-8 px-6 py-6">
      {error && (
        <div className="text-[13px] text-[var(--color-error)] bg-[var(--color-error)]/10 border border-[var(--color-error)]/20 rounded px-3 py-2">
          {error}
        </div>
      )}

      <section>
        <h2 className="text-[14px] font-semibold mb-3">Members</h2>
        {members.length === 0 && !adding && (
          <p className="text-[13px] text-[var(--color-foreground-muted)] mb-3">
            Définis qui s'occupe des bug reports pour ce projet. Chaque personne a besoin d'un bot Telegram pairé — voir <code>/pair</code> dans le channel Telegram.
          </p>
        )}
        <table className="w-full text-[13px]">
          <thead className="text-[var(--color-foreground-muted)]">
            <tr>
              <th className="text-left font-normal py-1">Display name</th>
              <th className="text-left font-normal py-1">Telegram bot</th>
              <th className="text-left font-normal py-1">Owner</th>
              <th className="w-24"></th>
            </tr>
          </thead>
          <tbody>
            {members.map(m => (
              <tr key={m.id} className="border-t border-[var(--color-border-subtle)]">
                <td className="py-2">{m.display_name}</td>
                <td className="py-2">@{m.dev_bot?.username} <span className="text-[var(--color-foreground-muted)]">({m.dev_bot?.label})</span></td>
                <td className="py-2">{m.dev_bot?.owner_first_name || '—'}</td>
                <td className="py-2 text-right">
                  <button onClick={() => deleteMemberAction(m.id)} className="text-[var(--color-error)] hover:underline">Remove</button>
                </td>
              </tr>
            ))}
            {adding && (
              <tr className="border-t border-[var(--color-border-subtle)]">
                <td className="py-2"><input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Alex" className="w-full bg-transparent border border-[var(--color-border-subtle)] rounded px-2 py-1" /></td>
                <td className="py-2">
                  {availableBots.length === 0 ? (
                    <span className="text-[var(--color-foreground-muted)]">Aucun bot disponible — paire-en un en Telegram d'abord : envoie <code>/pair &lt;token&gt; &lt;label&gt;</code> à <code>@Therealshelly42bot</code>.</span>
                  ) : (
                    <select value={newBotId} onChange={e => setNewBotId(e.target.value)} className="w-full bg-transparent border border-[var(--color-border-subtle)] rounded px-2 py-1">
                      <option value="">Pick a bot…</option>
                      {availableBots.map(b => (
                        <option key={b.id} value={b.id}>@{b.bot_username} ({b.bot_label})</option>
                      ))}
                    </select>
                  )}
                </td>
                <td></td>
                <td className="py-2 text-right">
                  <button onClick={addMemberAction} disabled={!newName || !newBotId} className="text-[var(--color-foreground)] hover:underline mr-3 disabled:opacity-40">Add</button>
                  <button onClick={() => { setAdding(false); setNewName(''); setNewBotId(''); }} className="text-[var(--color-foreground-muted)] hover:underline">Cancel</button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {!adding && (
          <button onClick={() => setAdding(true)} className="mt-3 text-[13px] text-[var(--color-accent)] hover:underline">+ Add member</button>
        )}
      </section>

      <section>
        <h2 className="text-[14px] font-semibold mb-3">Routing</h2>
        {members.length === 0 ? (
          <p className="text-[13px] text-[var(--color-foreground-muted)]">Add at least one member before defining routing rules.</p>
        ) : (
          <>
            <table className="w-full text-[13px]">
              <thead className="text-[var(--color-foreground-muted)]">
                <tr>
                  <th className="text-left font-normal py-1 w-1/2">Label</th>
                  <th className="text-left font-normal py-1">Member</th>
                  <th className="w-24"></th>
                </tr>
              </thead>
              <tbody>
                {draftRouting.map((rule, idx) => (
                  <tr key={idx} className="border-t border-[var(--color-border-subtle)]">
                    <td className="py-2">
                      <input
                        value={rule.label}
                        onChange={e => setRuleLabel(idx, e.target.value)}
                        placeholder="pedago"
                        className="w-full bg-transparent border border-[var(--color-border-subtle)] rounded px-2 py-1"
                      />
                    </td>
                    <td className="py-2">
                      <select
                        value={rule.member_id || ''}
                        onChange={e => setRuleMember(idx, e.target.value)}
                        className="w-full bg-transparent border border-[var(--color-border-subtle)] rounded px-2 py-1"
                      >
                        <option value="">Pick a member…</option>
                        {members.map(m => (
                          <option key={m.id} value={m.id}>{m.display_name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2 text-right">
                      <button onClick={() => removeRule(idx)} className="text-[var(--color-error)] hover:underline">Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex items-center gap-3">
              <button onClick={addEmptyRule} className="text-[13px] text-[var(--color-accent)] hover:underline">+ Add routing rule</button>
              <div className="flex-1" />
              {dirty && (
                <button onClick={() => setDraftRouting(routing)} className="text-[13px] text-[var(--color-foreground-muted)] hover:underline">
                  Discard
                </button>
              )}
              <button
                onClick={saveRouting}
                disabled={!dirty || savingRouting}
                className="text-[13px] px-3 py-1 rounded bg-[var(--color-accent)] text-[var(--color-accent-foreground)] disabled:opacity-40"
              >
                {savingRouting ? 'Saving…' : 'Save routing'}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Wire the panel into `settings-view.jsx`**

In `src/dashboard/views/settings-view.jsx`:

1. Import: `import TeamPanel from './settings-team-panel.jsx';`
2. Update `SECTIONS`:
   ```js
   const SECTIONS = [
     { id: 'project',       label: 'Project'       },
     { id: 'github',        label: 'GitHub'        },
     { id: 'team',          label: 'Team'          },
     { id: 'notifications', label: 'Notifications' },
     { id: 'storage',       label: 'Storage'       },
     { id: 'danger',        label: 'Danger Zone',  danger: true },
   ];
   ```
3. In the panel-render switch, add the team branch:
   ```jsx
   {section === 'team' && <TeamPanel project={project} apiKey={apiKey} apiBase={apiBase} />}
   ```
   (Adapt prop names — `apiKey`, `apiBase`, `project` — to whatever the surrounding component already passes to other panels.)

- [ ] **Step 4: Build the dashboard**

Run:
```bash
npm run build:dashboard 2>&1 | tail -20
```
Expected: build success.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/views/settings-team-panel.jsx src/dashboard/views/settings-view.jsx
git commit -m "feat(dashboard): Team settings panel — members + routing"
```

---

## Task 10b (optional): Storybook stories

The spec lists Storybook stories for the widget dropdown and the settings
panel. Skip if the worktree is on a tight clock — the manual smoke in Task 12
exercises the same paths. Add only if you have ≥30 min and Storybook is wired
in this repo (`npm run storybook` works locally).

**Files:**
- Create: `stories/team-panel.stories.jsx`
- Create: `stories/widget-category.stories.jsx`

- [ ] **Step 1: Story for empty + populated `TeamPanel`**

Mock fetch with `msw` or hand-rolled wrappers depending on the existing
Storybook setup. Stories: `Empty` (no members, no routing), `Populated`
(2 members, 3 routing rules), `NoBotsAvailable` (members > 0, available bots = 0).

- [ ] **Step 2: Story for widget dropdown rendered vs hidden**

Stories: `Hidden` (labels endpoint returns `[]`), `Rendered` (labels returns 3
options).

- [ ] **Step 3: Commit**

```bash
git add stories/team-panel.stories.jsx stories/widget-category.stories.jsx
git commit -m "docs(stories): TeamPanel + widget-category stories"
```

---

## Task 11: Shelly's SOUL — `[ticket-new]` reaction protocol

**Files:**
- Modify: `.agents/shelly/SOUL.md`

- [ ] **Step 1: Add the protocol section**

Open `.agents/shelly/SOUL.md`. Find the "Proactive behaviour" section (search for `## Proactive behaviour`). Add a new bullet at the end of that section's list:

```markdown
- **`[ticket-new]` — bug/feature submitted via the DevPanel widget.** Format:
  `[ticket-new] project=<name> ticket=<id> category=<label-or-empty> title="…"`.
  Reaction protocol:
  1. If `category` is set, skip to step 3.
  2. Call `get_team_labels(project)`. If the list is empty, ping Franck:
     "Nouveau bug sur \<project> mais pas de team configurée — settings?".
     Otherwise pick the best-matching label from title + (if you Read the
     ticket via `get_bugs`) description. If nothing fits, ping Franck.
  3. Call `route_ticket(project, ticket_id, label)`. If `already_routed` is
     true, stop — somebody else already pinged the right person. If the
     response has no member, fall back to Franck.
  4. Call `get_team_member(project, member_id)` if you need the dev_bot
     details (the `route_ticket` response already includes them).
  5. DM the member on their bot using
     `plugin:telegram:reply(bot_label=<dev_bot.label>, chat_id=<tg_user_id>, text=...)`.
     Prefix the message with `[thread:ticket/<id>]` so their reply lands in
     the ticket conversation. Voice: human, short, link to
     `https://devpanl.dev/dashboard/tickets/<id>` if the screenshot matters.
```

- [ ] **Step 2: Deploy the SOUL to the agents host**

Run:
```bash
bash scripts/deploy-agents.sh
```
Expected: SOUL synced. (If the script fails for unrelated reasons, scp the file manually:
`scp .agents/shelly/SOUL.md hetzner-vps:/home/deploy/projects/dev-panel/.agents/shelly/SOUL.md`.)

- [ ] **Step 3: Restart Shelly to pick up the new SOUL**

Run:
```bash
ssh hetzner-vps 'sudo systemctl restart shelly.service'
```
Expected: service restarts cleanly.

- [ ] **Step 4: Commit**

```bash
git add .agents/shelly/SOUL.md
git commit -m "docs(shelly): [ticket-new] reaction protocol"
```

---

## Task 12: End-to-end smoke test

**Files:** none (manual verification).

- [ ] **Step 1: Run the full server-side test suite**

Run:
```bash
TEST_PG=1 npx vitest run tests/server/ 2>&1 | tail -30
```
Expected: all PASS (or only pre-existing skips).

- [ ] **Step 2: Deploy dev-panel to services VPS**

Run:
```bash
git push origin main
```
Wait for `.github/workflows/deploy.yml` to refresh the `devpanel` container. (You can watch with `gh run watch` if `gh` is set up.)

- [ ] **Step 3: Apply migration 006 on the prod Postgres**

Run:
```bash
ssh deploy@77.42.46.87 \
  'docker exec -i devpanel-postgres psql -U affine -d agent_memory -v ON_ERROR_STOP=1' \
  < infra/migrations/006-team-routing.sql
```
Expected: `BEGIN`/`COMMIT` lines, no errors.

- [ ] **Step 4: Configure team for the dev-panel project (smoke target)**

Open `https://devpanl.dev/dashboard/settings`. Pick the `dev-panel` project. Open the new **Team** tab. Add yourself as a member linked to the `franck` bot. Add one routing rule: `label = test, member = Franck`. Save.

- [ ] **Step 5: Submit a test bug from the widget**

Open any project that has the widget mounted (or submit via curl):
```bash
curl -X POST https://devpanl.dev/api/tickets \
  -H "X-API-Key: <dev-panel project key from /api/projects>" \
  -H "Content-Type: application/json" \
  -d '{"type":"bug","title":"Smoke: team routing","description":"From CLI","category":"test"}'
```
Expected: `201 Created`.

- [ ] **Step 6: Verify the Telegram DM**

Watch your Telegram. Within ~30 s you should receive a DM on `@Therealshelly42bot` (Franck's bot) with `[thread:ticket/<id>]` prefix and a human-voice description of the bug.

- [ ] **Step 7: Verify the reply path**

Reply to that DM in Telegram. Open the ticket in
`https://devpanl.dev/dashboard/tickets/<id>` — your reply should appear in the
conversation thread.

- [ ] **Step 8: Verify idempotency**

POST the same ticket id to `/api/tickets/:id/route` again (manually):
```bash
curl -X POST https://devpanl.dev/api/tickets/<id>/route \
  -H "X-API-Key: <key>" -H "Content-Type: application/json" \
  -d '{"label":"test"}'
```
Expected: `already_routed: true` in the response, no second DM in Telegram.

- [ ] **Step 9: Verify classification path (no category)**

Submit another ticket *without* `category`:
```bash
curl -X POST https://devpanl.dev/api/tickets \
  -H "X-API-Key: <key>" -H "Content-Type: application/json" \
  -d '{"type":"bug","title":"Smoke: classify me","description":"This is a test classification ticket."}'
```
Expected: Shelly should classify into `test` (the only label) and DM you. If she pings Franck saying "no team configured" instead, check the SOUL deployed and her tmux pane.

- [ ] **Step 10: Commit any drift**

If the smoke surfaced any small fix (typo in copy, missing import), make the fix as a separate commit:
```bash
git add -p
git commit -m "fix(team-routing): <what you fixed>"
git push
```
