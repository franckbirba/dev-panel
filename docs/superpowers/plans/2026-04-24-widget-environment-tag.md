# Widget Environment Tag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the host app tag each widget capture with a free-form environment label (`dev`, `staging`, `production`, `preview-pr-42`…) that flows through POST/GET, persists as an indexed column on `captures`, and surfaces in the dashboard as a color-coded badge plus a filter dropdown.

**Architecture:** React widget gains optional `environment` prop (plus `data-environment` on the standalone `/widget.js` script tag) → `POST /api/captures` validates a slug-ish string and forwards it → `createCapture` writes a single `environment TEXT` column → `listCaptures` filters on `environment` → dashboard reads `capture.environment`, renders a deterministic-colored pill, and adds a second filter dropdown alongside the existing `reporter` one.

**Tech Stack:** React 18, Express, better-sqlite3, Vite (widget bundle), Vitest + supertest + @testing-library/react.

---

## File Structure

- **`src/server/db.js`** — adds migration v4 (1 column + 1 index on `captures`).
- **`src/server/captures.js`** — `createCapture` accepts `environment`; `listCaptures` filters by `environment`.
- **`src/server/routes.js`** — `POST /api/captures` validates `environment`; `GET /api/captures` accepts `environment` query param.
- **`src/react/reporterPayload.js`** — `buildCaptureRequestPayload` extended to append `environment`.
- **`src/react/DevPanel.jsx`** — new optional `environment` prop, forwarded to `buildCaptureRequestPayload`.
- **`src/react/widget-entry.jsx`** — reads `script.dataset.environment`, passes to `<DevPanel>`.
- **`src/dashboard/views/captures-view.jsx`** — env badge on cards + second filter dropdown + URL-state wiring identical to reporter.
- **`tests/server/db-environment-migration.test.js`** *(new)* — migration v4 is idempotent, adds the column and index.
- **`tests/server/captures-environment.test.js`** *(new)* — createCapture stores env; listCaptures filters by env.
- **`tests/server/routes-captures-environment.test.js`** *(new)* — POST validation, round-trip, GET filter.
- **`tests/react/reporterPayload.test.js`** *(extend)* — add env cases (present, absent, non-string).
- **`tests/react/devpanel-environment.test.jsx`** *(new)* — widget forwards `environment` in request body; omits when absent / non-string.
- **`tests/react/widget-entry-environment.test.jsx`** *(new)* — `widget-entry.jsx` reads `data-environment` and passes it to `DevPanel`.
- **`dist/widget.js`** — rebuilt bundle.

---

## Task 1: Database migration v4

**Files:**
- Modify: `src/server/db.js` (migration block after v3 at ~line 277)
- Create: `tests/server/db-environment-migration.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/server/db-environment-migration.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { initMasterDatabase, closeAllDatabases } from '../../src/server/db.js';

describe('captures environment migration (v4)', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-envmig-'));
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('adds environment column to captures', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    const cols = new Set(raw.prepare('PRAGMA table_info(captures)').all().map(c => c.name));
    expect(cols.has('environment')).toBe(true);
    raw.close();
  });

  it('creates idx_captures_environment index', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    const idx = new Set(raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='captures'`
    ).all().map(r => r.name));
    expect(idx.has('idx_captures_environment')).toBe(true);
    raw.close();
  });

  it('bumps user_version to at least 4', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    const v = raw.pragma('user_version', { simple: true });
    expect(v).toBeGreaterThanOrEqual(4);
    raw.close();
  });

  it('is idempotent: running init twice does not throw', () => {
    initMasterDatabase(tmp);
    closeAllDatabases();
    expect(() => initMasterDatabase(tmp)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run tests/server/db-environment-migration.test.js`
Expected: FAIL — column `environment` does not exist yet.

- [ ] **Step 3: Add migration v4 to `src/server/db.js`**

In `src/server/db.js`, right after the v3 block (just before `return masterDb;` at around line 278), insert:

```js
  // Migration v4: environment tag on captures.
  // Single nullable TEXT column + one index. Host app stamps each capture with
  // a free-form slug (dev, staging, production, preview-pr-42…). Server
  // validates slug charset in the route layer; DB just stores the string.
  // Guarded by user_version. See spec:
  // docs/superpowers/specs/2026-04-24-widget-environment-tag-design.md
  const ENVIRONMENT_TAG_VERSION = 4;
  const currentVersion4 = masterDb.pragma('user_version', { simple: true });
  if (currentVersion4 < ENVIRONMENT_TAG_VERSION) {
    const capCols4 = new Set(masterDb.prepare("PRAGMA table_info(captures)").all().map(c => c.name));
    if (!capCols4.has('environment')) masterDb.exec(`ALTER TABLE captures ADD COLUMN environment TEXT`);
    masterDb.exec(`CREATE INDEX IF NOT EXISTS idx_captures_environment ON captures(environment)`);
    masterDb.pragma(`user_version = ${ENVIRONMENT_TAG_VERSION}`);
  }
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run tests/server/db-environment-migration.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Re-run v3 migration test to confirm no regression**

Run: `npx vitest run tests/server/db-reporter-migration.test.js`
Expected: PASS (all v3 tests still green).

- [ ] **Step 6: Commit**

```bash
git add src/server/db.js tests/server/db-environment-migration.test.js
git commit -m "feat(db): add environment column migration v4 on captures"
```

---

## Task 2: `createCapture` and `listCaptures` accept environment

**Files:**
- Modify: `src/server/captures.js` (functions `createCapture`, `listCaptures`)
- Create: `tests/server/captures-environment.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/server/captures-environment.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject, closeAllDatabases } from '../../src/server/db.js';
import { createCapture, getCapture, listCaptures } from '../../src/server/captures.js';

vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ getJobs: async () => [] }),
  QUEUES: { agent: 'agent' }
}));

describe('captures environment tag', () => {
  let tmp, project;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-capenv-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo' });
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('stores environment string on createCapture', () => {
    const cap = createCapture({
      project_id: project.id,
      content: 'bug on page 7',
      kind: 'bug',
      environment: 'production'
    });
    expect(cap.environment).toBe('production');
  });

  it('leaves environment null when not passed', () => {
    const cap = createCapture({ project_id: project.id, content: 'x' });
    expect(cap.environment).toBeNull();
  });

  it('stores null when environment is explicitly null', () => {
    const cap = createCapture({ project_id: project.id, content: 'x', environment: null });
    expect(cap.environment).toBeNull();
  });

  it('getCapture returns the environment string as-is', () => {
    const created = createCapture({
      project_id: project.id,
      content: 'x',
      environment: 'staging'
    });
    const full = getCapture(created.id);
    expect(full.environment).toBe('staging');
  });

  it('listCaptures filters by environment', () => {
    createCapture({ project_id: project.id, content: 'a', environment: 'production' });
    createCapture({ project_id: project.id, content: 'b', environment: 'staging' });
    createCapture({ project_id: project.id, content: 'c' });
    const prod = listCaptures({ project_id: project.id, environment: 'production' });
    expect(prod.length).toBe(1);
    expect(prod[0].content).toBe('a');
  });

  it('listCaptures without environment filter returns all rows', () => {
    createCapture({ project_id: project.id, content: 'a', environment: 'production' });
    createCapture({ project_id: project.id, content: 'b' });
    const all = listCaptures({ project_id: project.id });
    expect(all.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run tests/server/captures-environment.test.js`
Expected: FAIL — `createCapture` ignores `environment`; `listCaptures` has no `environment` filter.

- [ ] **Step 3: Update `createCapture` in `src/server/captures.js`**

Replace the existing `createCapture` export (current signature at ~line 24) with:

```js
export function createCapture({ project_id, content, kind = 'idea', created_by = 'franck', reporter = null, environment = null }) {
  const db = getMasterDatabase();
  const id = randomUUID();

  const rep = normalizeReporter(reporter);
  const env = (typeof environment === 'string' && environment.length > 0) ? environment : null;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO captures
         (id, project_id, kind, content, status, created_by,
          reporter_id, reporter_name, reporter_email, reporter_extra,
          environment)
       VALUES (?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)`
    ).run(
      id, project_id, kind, content, created_by,
      rep.id, rep.name, rep.email, rep.extra,
      env
    );

    upsertSubject({
      subject_type: 'capture',
      subject_id: id,
      project_id,
      title: content.slice(0, 120)
    });

    const thread = getOrCreateThread('capture', id);
    appendMessage({
      thread_id: thread.thread_id,
      role: 'user',
      source: 'web',
      content
    });
  });
  tx();

  return getCapture(id);
}
```

- [ ] **Step 4: Update `listCaptures` in `src/server/captures.js`**

Replace the existing `listCaptures` (current signature at ~line 110) with:

```js
export function listCaptures({ project_id, status = null, reporter_id = null, environment = null, limit = 100 }) {
  const db = getMasterDatabase();
  let sql = `
    SELECT c.*,
           COALESCE((SELECT COUNT(*) FROM thread_messages tm
                       JOIN threads t ON t.thread_id=tm.thread_id
                      WHERE t.subject_type='capture' AND t.subject_id=c.id), 0) AS message_count,
           (SELECT tm.content FROM thread_messages tm
              JOIN threads t ON t.thread_id=tm.thread_id
             WHERE t.subject_type='capture' AND t.subject_id=c.id
             ORDER BY tm.created_at DESC, tm.id DESC LIMIT 1) AS last_message,
           (SELECT tm.role FROM thread_messages tm
              JOIN threads t ON t.thread_id=tm.thread_id
             WHERE t.subject_type='capture' AND t.subject_id=c.id
             ORDER BY tm.created_at DESC, tm.id DESC LIMIT 1) AS last_role
      FROM captures c
     WHERE c.project_id = ?
  `;
  const params = [project_id];
  if (status)      { sql += ` AND c.status = ?`;      params.push(status); }
  if (reporter_id) { sql += ` AND c.reporter_id = ?`; params.push(reporter_id); }
  if (environment) { sql += ` AND c.environment = ?`; params.push(environment); }
  sql += ` ORDER BY c.updated_at DESC, c.created_at DESC LIMIT ?`;
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  return rows.map(r => ({ ...r, reporter: assembleReporter(r) }));
}
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `npx vitest run tests/server/captures-environment.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Re-run existing captures tests to verify no regression**

Run: `npx vitest run tests/server/captures-reporter.test.js`
Expected: PASS (unchanged count).

- [ ] **Step 7: Commit**

```bash
git add src/server/captures.js tests/server/captures-environment.test.js
git commit -m "feat(captures): accept and filter by environment tag"
```

---

## Task 3: Route `POST /api/captures` validates environment, `GET` filters

**Files:**
- Modify: `src/server/routes.js` (POST /captures at ~line 720, GET /captures at ~line 739)
- Create: `tests/server/routes-captures-environment.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/server/routes-captures-environment.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import express from 'express';
import { initMasterDatabase, createProject, closeAllDatabases } from '../../src/server/db.js';
import { buildRouter } from '../../src/server/routes.js';

vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ getJobs: async () => [], add: async () => ({}) }),
  QUEUES: { agent: 'agent' }
}));

describe('POST/GET /api/captures environment', () => {
  let tmp, project, app;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-renv-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo' });
    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api', buildRouter({ storagePath: tmp }));
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('stores environment when provided', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', environment: 'production' });
    expect(res.status).toBe(201);
    expect(res.body.environment).toBe('production');
  });

  it('accepts captures without environment (backward compat)', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x' });
    expect(res.status).toBe(201);
    expect(res.body.environment).toBeNull();
  });

  it('accepts slug-ish environment values (preview-pr-42)', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', environment: 'preview-pr-42' });
    expect(res.status).toBe(201);
    expect(res.body.environment).toBe('preview-pr-42');
  });

  it('truncates environment to 64 chars', async () => {
    const long = 'a'.repeat(100);
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', environment: long });
    // Server trims post-validation; regex only matches within 64 chars so
    // a 100-char string actually fails the regex. Assert 400 on too-long.
    expect(res.status).toBe(400);
  });

  it('rejects environment containing invalid chars (space, semicolon)', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', environment: 'hack; DROP TABLE' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/environment/i);
  });

  it('rejects environment that is not a string (number)', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', environment: 42 });
    expect(res.status).toBe(400);
  });

  it('accepts environment: null (treated as absent)', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', environment: null });
    expect(res.status).toBe(201);
    expect(res.body.environment).toBeNull();
  });

  it('GET /captures?environment=staging filters', async () => {
    const post = (body) => request(app).post('/api/captures').set('X-API-Key', project.api_key).send(body);
    await post({ content: 'a', environment: 'production' });
    await post({ content: 'b', environment: 'staging' });
    await post({ content: 'c' });

    const r = await request(app)
      .get('/api/captures?environment=staging')
      .set('X-API-Key', project.api_key);
    expect(r.status).toBe(200);
    expect(r.body.captures.length).toBe(1);
    expect(r.body.captures[0].content).toBe('b');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run tests/server/routes-captures-environment.test.js`
Expected: FAIL — route ignores `environment`.

- [ ] **Step 3: Update `POST /captures` handler in `src/server/routes.js`**

Replace the `POST /captures` handler (around line 720) with:

```js
  router.post('/captures', authenticateProject, (req, res) => {
    try {
      const { content = '', kind = 'idea', reporter, environment } = req.body || {};
      if (!String(content).trim()) return res.status(400).json({ error: 'content required' });
      if (reporter !== undefined && reporter !== null) {
        if (typeof reporter !== 'object' || Array.isArray(reporter)) {
          return res.status(400).json({ error: 'reporter must be an object' });
        }
      }
      let env = null;
      if (environment !== undefined && environment !== null) {
        if (typeof environment !== 'string') {
          return res.status(400).json({ error: 'environment must be a string' });
        }
        const trimmed = environment.trim();
        if (trimmed.length === 0 || trimmed.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
          return res.status(400).json({ error: 'environment must be a slug (1-64 chars, [a-zA-Z0-9._-])' });
        }
        env = trimmed;
      }
      const capture = createCapture({
        project_id: req.project.id,
        content: String(content).slice(0, 4000),
        kind: String(kind).slice(0, 32),
        reporter: reporter ?? null,
        environment: env
      });
      res.status(201).json(capture);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
```

- [ ] **Step 4: Update `GET /captures` handler in `src/server/routes.js`**

Replace the `GET /captures` handler (around line 739) with:

```js
  router.get('/captures', authenticateProject, (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : null;
      const reporter_id = req.query.reporter_id ? String(req.query.reporter_id) : null;
      const environment = req.query.environment ? String(req.query.environment).slice(0, 64) : null;
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
      res.json({ captures: listCaptures({ project_id: req.project.id, status, reporter_id, environment, limit }) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `npx vitest run tests/server/routes-captures-environment.test.js`
Expected: PASS (8 tests).

- [ ] **Step 6: Re-run full server test suite to catch regressions**

Run: `npx vitest run tests/server/`
Expected: All pre-existing tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/routes.js tests/server/routes-captures-environment.test.js
git commit -m "feat(api): accept environment on captures POST, filter on GET"
```

---

## Task 4: `buildCaptureRequestPayload` includes environment

**Files:**
- Modify: `src/react/reporterPayload.js`
- Modify: `tests/react/reporterPayload.test.js`

- [ ] **Step 1: Extend the failing test**

Append these cases to `tests/react/reporterPayload.test.js`, inside the existing `describe('buildCaptureRequestPayload', ...)` block:

```js
  it('includes environment when it is a non-empty string', () => {
    const body = buildCaptureRequestPayload(null, 'bug', 'x', 'production');
    expect(body.environment).toBe('production');
  });

  it('omits environment when it is undefined', () => {
    const body = buildCaptureRequestPayload(null, 'bug', 'x');
    expect('environment' in body).toBe(false);
  });

  it('omits environment when it is null', () => {
    const body = buildCaptureRequestPayload(null, 'bug', 'x', null);
    expect('environment' in body).toBe(false);
  });

  it('omits environment when it is an empty string', () => {
    const body = buildCaptureRequestPayload(null, 'bug', 'x', '');
    expect('environment' in body).toBe(false);
  });

  it('omits environment when it is not a string (number)', () => {
    const body = buildCaptureRequestPayload(null, 'bug', 'x', 42);
    expect('environment' in body).toBe(false);
  });

  it('carries both reporter and environment together', () => {
    const body = buildCaptureRequestPayload(
      { id: 'u_1', name: 'Alice' },
      'bug',
      'broken',
      'staging'
    );
    expect(body).toEqual({
      kind: 'bug',
      content: 'broken',
      reporter: { id: 'u_1', name: 'Alice' },
      environment: 'staging'
    });
  });
```

- [ ] **Step 2: Run tests — verify the new ones fail**

Run: `npx vitest run tests/react/reporterPayload.test.js`
Expected: the 6 new tests FAIL (unknown fourth arg); existing 5 still PASS.

- [ ] **Step 3: Extend `buildCaptureRequestPayload`**

Replace the full contents of `src/react/reporterPayload.js` with:

```js
// Build the JSON body for POST /api/captures.
// - `user` (object) → `reporter` field on the body.
// - `environment` (non-empty string) → `environment` field on the body.
// Both are optional. Pure function — no React, no fetch — so tests can run
// without jsdom.
export function buildCaptureRequestPayload(user, kind, content, environment) {
  const body = { kind, content };
  if (user && typeof user === 'object' && !Array.isArray(user)) {
    body.reporter = user;
  }
  if (typeof environment === 'string' && environment.length > 0) {
    body.environment = environment;
  }
  return body;
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run tests/react/reporterPayload.test.js`
Expected: PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/react/reporterPayload.js tests/react/reporterPayload.test.js
git commit -m "feat(widget): extend payload builder with environment"
```

---

## Task 5: DevPanel forwards `environment` prop

**Files:**
- Modify: `src/react/DevPanel.jsx` (props signature ~line 22, `postCapture` ~line 112)
- Create: `tests/react/devpanel-environment.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `tests/react/devpanel-environment.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { DevPanel } from '../../src/react/DevPanel.jsx';

describe('DevPanel environment forwarding', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: 'cap_1' })
    }));
    Object.defineProperty(global.navigator, 'mediaDevices', {
      value: { getDisplayMedia: vi.fn() },
      configurable: true
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    cleanup();
  });

  async function openBugFormAndSubmit(props) {
    render(<DevPanel apiUrl="http://test" apiKey="dp_test" {...props} />);
    fireEvent.click(screen.getByLabelText('DevPanel'));
    fireEvent.click(screen.getByText(/Report Bug/i));
    const textarea = await screen.findByPlaceholderText(/describe|bug|issue/i);
    fireEvent.change(textarea, { target: { value: 'something broke' } });
    fireEvent.click(screen.getByText(/submit|send|report/i));
    await waitFor(() => {
      const captureCall = global.fetch.mock.calls.find(c => String(c[0]).endsWith('/api/captures'));
      expect(captureCall).toBeDefined();
    });
    const captureCall = global.fetch.mock.calls.find(c => String(c[0]).endsWith('/api/captures'));
    return JSON.parse(captureCall[1].body);
  }

  it('includes environment in the POST body when `environment` prop is passed', async () => {
    const body = await openBugFormAndSubmit({ environment: 'production' });
    expect(body.environment).toBe('production');
  });

  it('omits environment when `environment` prop is not passed', async () => {
    const body = await openBugFormAndSubmit({});
    expect(body.environment).toBeUndefined();
  });

  it('omits environment when `environment` prop is not a string', async () => {
    const body = await openBugFormAndSubmit({ environment: 42 });
    expect(body.environment).toBeUndefined();
  });

  it('carries both user and environment together', async () => {
    const body = await openBugFormAndSubmit({
      user: { id: 'u_1', name: 'Alice' },
      environment: 'staging'
    });
    expect(body.reporter).toEqual({ id: 'u_1', name: 'Alice' });
    expect(body.environment).toBe('staging');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run tests/react/devpanel-environment.test.jsx`
Expected: FAIL — widget doesn't forward `environment`.

- [ ] **Step 3: Update DevPanel props signature**

In `src/react/DevPanel.jsx`, replace the component parameter block (currently lines 22-28) with:

```jsx
export function DevPanel({
  apiUrl = 'http://localhost:3030',
  apiKey,
  position = 'bottom-right',
  getState = null,
  user = null,
  environment = null
}) {
```

- [ ] **Step 4: Forward `environment` through `postCapture`**

Still in `src/react/DevPanel.jsx`, replace the `postCapture` callback (currently lines 112-142) with:

```jsx
  const postCapture = useCallback(async ({ kind, content, metadata }) => {
    const createRes = await fetch(`${apiUrl}/api/captures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify(buildCaptureRequestPayload(user, kind, content, environment))
    });
    if (!createRes.ok) {
      const errData = await createRes.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${createRes.status}`);
    }
    const capture = await createRes.json();
    if (metadata) {
      const summary = [
        metadata.screenshot ? 'screenshot' : null,
        metadata.dom ? 'DOM snapshot' : null,
        metadata.appState ? 'app state' : null,
        Array.isArray(metadata.console) && metadata.console.length > 0 ? `${metadata.console.length} console entries` : null,
        Array.isArray(metadata.network) && metadata.network.length > 0 ? `${metadata.network.length} network events` : null,
      ].filter(Boolean).join(' · ') || 'browser context';
      await fetch(`${apiUrl}/api/threads/capture/${capture.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({
          role: 'system',
          content: `Captured: ${summary}`,
          metadata
        })
      }).catch(() => { /* context is best-effort */ });
    }
    return capture;
  }, [apiUrl, apiKey, user, environment]);
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `npx vitest run tests/react/devpanel-environment.test.jsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Re-run existing widget tests to catch regressions**

Run: `npx vitest run tests/react/`
Expected: all existing react tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add src/react/DevPanel.jsx tests/react/devpanel-environment.test.jsx
git commit -m "feat(widget): forward host-app environment tag"
```

---

## Task 6: Standalone `/widget.js` reads `data-environment`

**Files:**
- Modify: `src/react/widget-entry.jsx`
- Create: `tests/react/widget-entry-environment.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `tests/react/widget-entry-environment.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock DevPanel so we can inspect the props passed by widget-entry without
// mounting the full React tree.
const devPanelPropsSpy = vi.fn();
vi.mock('../../src/react/DevPanel.jsx', () => ({
  DevPanel: (props) => {
    devPanelPropsSpy(props);
    return null;
  }
}));

describe('widget-entry reads data-environment', () => {
  beforeEach(() => {
    devPanelPropsSpy.mockClear();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  afterEach(() => {
    // Re-import fresh module next describe if needed
    vi.resetModules();
  });

  function installScript({ apiKey, apiUrl, environment } = {}) {
    const s = document.createElement('script');
    s.src = '/widget.js';
    if (apiKey)      s.dataset.apiKey      = apiKey;
    if (apiUrl)      s.dataset.apiUrl      = apiUrl;
    if (environment) s.dataset.environment = environment;
    document.body.appendChild(s);
    return s;
  }

  it('passes environment from data-environment to DevPanel', async () => {
    installScript({ apiKey: 'dp_test', environment: 'staging' });
    // document.currentScript is null here — widget-entry falls back to
    // querying for the script[src*="/widget.js"][data-api-key].
    await import('../../src/react/widget-entry.jsx');
    expect(devPanelPropsSpy).toHaveBeenCalledTimes(1);
    expect(devPanelPropsSpy.mock.calls[0][0].environment).toBe('staging');
  });

  it('passes undefined environment when data-environment is missing', async () => {
    installScript({ apiKey: 'dp_test' });
    await import('../../src/react/widget-entry.jsx');
    expect(devPanelPropsSpy).toHaveBeenCalledTimes(1);
    expect(devPanelPropsSpy.mock.calls[0][0].environment).toBeUndefined();
  });
});
```

Note: each `it` imports the module fresh because widget-entry executes its `mount()` at import time. Vitest isolates modules between tests by default under `vi.resetModules()` in `afterEach` — if runs contaminate each other in practice, switch to one test file per case.

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run tests/react/widget-entry-environment.test.jsx`
Expected: FAIL — `widget-entry.jsx` does not forward `environment`.

- [ ] **Step 3: Update `src/react/widget-entry.jsx`**

Replace the `mount()` function body (currently lines 15-43) with:

```jsx
function mount() {
  const script = document.currentScript
    ?? document.querySelector('script[src*="/widget.js"][data-api-key]');

  if (document.getElementById(ROOT_ID)) {
    const existing = document.getElementById(ROOT_ID).dataset.apiKey;
    if (script?.dataset?.apiKey && existing && script.dataset.apiKey !== existing) {
      console.warn('[DevPanel widget] already mounted with a different apiKey; ignoring second <script>.');
    }
    return;
  }
  const apiKey      = script?.dataset?.apiKey;
  const apiUrl      = script?.dataset?.apiUrl;
  const environment = script?.dataset?.environment;

  if (!apiKey) {
    console.warn('[DevPanel widget] data-api-key missing on <script>, not mounting.');
    return;
  }

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.dataset.apiKey = apiKey;
  document.body.appendChild(root);
  createRoot(root).render(
    <DevPanel apiKey={apiKey} apiUrl={apiUrl} environment={environment} />
  );
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run tests/react/widget-entry-environment.test.jsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/react/widget-entry.jsx tests/react/widget-entry-environment.test.jsx
git commit -m "feat(widget): data-environment on standalone script tag"
```

---

## Task 7: Dashboard — env badge + filter dropdown

**Files:**
- Modify: `src/dashboard/views/captures-view.jsx`

The dashboard uses no React Testing Library today (same convention as the reporter rollout) — Step 5 is a manual browser check.

- [ ] **Step 1: Add an env filter state**

In `src/dashboard/views/captures-view.jsx`, add near the existing `reporterFilter` useState (around line 42):

```jsx
  const [envFilter, setEnvFilter] = useState('');
```

- [ ] **Step 2: Extend `loadList` to include env filter**

Replace the `loadList` callback (currently lines 47-65) with:

```jsx
  const loadList = useCallback(async () => {
    if (!apiKey) return;
    try {
      const full = await fetch(`${apiUrl}/api/captures`, { headers: { 'X-API-Key': apiKey } });
      if (!full.ok) throw new Error(`HTTP ${full.status}`);
      const fullBody = await full.json();
      setAllList(fullBody.captures);

      const qs = [];
      if (reporterFilter) qs.push(`reporter_id=${encodeURIComponent(reporterFilter)}`);
      if (envFilter)      qs.push(`environment=${encodeURIComponent(envFilter)}`);

      if (qs.length > 0) {
        const r = await fetch(`${apiUrl}/api/captures?${qs.join('&')}`, { headers: { 'X-API-Key': apiKey } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { captures } = await r.json();
        setList(captures);
      } else {
        setList(fullBody.captures);
      }
      setError(null);
    } catch (e) { setError(e.message); }
  }, [apiUrl, apiKey, reporterFilter, envFilter]);
```

- [ ] **Step 3: Derive distinct environments from the unfiltered list**

Next to the existing `reporters` derivation (around line 142 in the current file), add a `environments` derivation. Find the block where `reporters` is computed from `allList` and insert below it:

```jsx
  const environments = Array.from(new Set(
    allList.map(c => c.environment).filter(Boolean)
  )).sort();
```

- [ ] **Step 4: Add env color helper, badge, and dropdown**

Near the top of the file (below the `STATUS_CHIP` constant, around line 13), add a deterministic hue helper:

```jsx
// djb2 string hash → HSL hue. Same env string always gets the same pill color
// across dashboards, without hardcoding a palette. Saturation/lightness are
// fixed so pills look consistent against the surface palette.
function envHue(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h % 360;
}
function envPillStyle(env) {
  const hue = envHue(env);
  return {
    backgroundColor: `hsl(${hue}, 55%, 20%)`,
    color:           `hsl(${hue}, 75%, 82%)`,
    border:          `1px solid hsl(${hue}, 55%, 30%)`
  };
}
```

Inside the card-header row (the `<div className="flex items-center gap-2 mb-1.5">` block, around line 231-239), add the env pill after the reporter span and before the time span. Replace:

```jsx
                <div className="flex items-center gap-2 mb-1.5">
                  <StatusChip status={c.status} />
                  {(c.reporter_name || c.reporter_email) && (
                    <span className="text-[10.5px] text-[var(--color-foreground-muted)] truncate max-w-[120px]">
                      {c.reporter_name || c.reporter_email}
                    </span>
                  )}
                  <span className="text-[10.5px] text-[var(--color-foreground-faint)] font-mono ml-auto">{timeAgo(c.updated_at)}</span>
                </div>
```

With:

```jsx
                <div className="flex items-center gap-2 mb-1.5">
                  <StatusChip status={c.status} />
                  {(c.reporter_name || c.reporter_email) && (
                    <span className="text-[10.5px] text-[var(--color-foreground-muted)] truncate max-w-[120px]">
                      {c.reporter_name || c.reporter_email}
                    </span>
                  )}
                  {c.environment && (
                    <span
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wide"
                      style={envPillStyle(c.environment)}
                    >
                      {c.environment}
                    </span>
                  )}
                  <span className="text-[10.5px] text-[var(--color-foreground-faint)] font-mono ml-auto">{timeAgo(c.updated_at)}</span>
                </div>
```

In the list-header row (around line 196 — `<div className="px-4 h-9 ...">`), add a second `<select>` after the existing `reporters` dropdown. Locate the `{reporters.length > 0 && (...)}` block and insert immediately after it, inside the same parent `<div>`:

```jsx
            {environments.length > 0 && (
              <select
                value={envFilter}
                onChange={(e) => setEnvFilter(e.target.value)}
                className="text-[11px] bg-transparent border border-[var(--color-border-subtle)] rounded px-1 py-0.5 normal-case font-normal tracking-normal"
              >
                <option value="">all envs</option>
                {environments.map((env) => (
                  <option key={env} value={env}>{env}</option>
                ))}
              </select>
            )}
```

Note: the existing `reporters` select uses `className="ml-auto …"`. Keeping `ml-auto` on the reporter select pushes both it and the env select to the right together — that's the intent.

- [ ] **Step 5: Manual browser check**

1. Start the API and dashboard: `node bin/dev-panel.js serve &` and `npm run dev:dashboard` in another terminal.
2. In a scratch HTML page, embed the widget twice with different env tags:

   ```html
   <script src="http://localhost:3030/widget.js" data-api-key="dp_..." data-environment="staging"></script>
   ```

3. Submit one capture from each env.
4. Open the dashboard Inbox and confirm:
   - Each capture card shows a colored env pill (same env → same color; different env → different color).
   - The "all envs" dropdown appears in the list header and contains exactly the two env values.
   - Selecting `staging` narrows the list to the staging capture.
   - Clearing the dropdown (select "all envs") restores the full list.
   - Captures submitted without `data-environment` have no pill and don't appear in the dropdown.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/views/captures-view.jsx
git commit -m "feat(dashboard): env badge and filter on captures"
```

---

## Task 8: Rebuild the widget bundle

**Files:**
- Modify: `dist/widget.js` (generated artifact)

- [ ] **Step 1: Build the widget**

Run: `npm run build:widget`
Expected: Vite rebuilds `dist/widget.js` (plus any hashed CSS). The previous reporter-era bundle gets replaced with the env-aware one.

- [ ] **Step 2: Confirm the built bundle references environment**

Run: `grep -c environment dist/widget.js`
Expected: at least 1 match.

- [ ] **Step 3: Smoke-check the bundle size is comparable**

Run: `wc -c dist/widget.js`
Expected: within ~20% of the previous size (roughly 420-500 KB). A sudden jump to >1 MB means the `NODE_ENV=production` define regressed — check `vite.widget.config.js`.

- [ ] **Step 4: Commit the rebuilt widget**

```bash
git add dist/widget.js
git commit -m "chore(widget): rebuild bundle with environment tag"
```

---

## Self-Review

Cross-checking the plan against the spec:

1. **Spec §1 Widget API (`environment` prop + `data-environment`)** → Task 5 (prop) + Task 6 (data-attr).
2. **Spec §2 Wire format (`buildCaptureRequestPayload`)** → Task 4.
3. **Spec §3 API contract (POST validation + GET filter)** → Task 3.
4. **Spec §4 Database migration v4** → Task 1.
5. **Spec §5 Capture module (`createCapture`, `listCaptures`)** → Task 2.
6. **Spec §6 Dashboard (badge + dropdown + URL state)** → Task 7. URL-state wiring inherits from the existing reporter pattern (query string built from filters) — Step 2 already composes both filters into the GET; bookmarking via URL is satisfied by React Router-style state (not yet implemented for reporter either, so out of scope for this plan if Franck hasn't asked for it — the existing view state mirrors the spec's "same pattern as reporter filter" promise).
7. **Spec §7 Widget bundle rebuild** → Task 8.
8. **Spec §8 Backward compat** → covered by tests in Task 2 (null when absent), Task 3 (accepts captures without env), Task 4 (omits env from payload when absent), Task 5 (widget omits env when prop absent).

No placeholders, no TBDs in code. All file paths absolute. Test code and implementation code are shown in full. Function signatures are consistent: `createCapture({..., environment})`, `listCaptures({..., environment})`, `buildCaptureRequestPayload(user, kind, content, environment)` — the 4th arg name matches across definition, call-site, and tests. The `envHue` / `envPillStyle` helpers are defined before they are used.

One known tradeoff called out explicitly: Spec §6 mentions bookmarkable URL state for `?environment=`; Task 7 composes the filter into the GET query but does not push it to the browser URL, matching the current state of the reporter filter in `captures-view.jsx` (no URL sync yet). If Franck later wants URL sync, it's a single follow-up touching both filters together.
