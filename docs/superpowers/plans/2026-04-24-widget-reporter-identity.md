# Widget Reporter Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the host app hand the DevPanel widget a user identity so multi-user apps (Zeno) can tell who reported each capture. Single-user apps (EDMS) keep working unchanged.

**Architecture:** React widget gains optional `user` prop → `POST /api/captures` accepts a `reporter` object → `createCapture` splits it into queryable columns (`reporter_id`, `reporter_name`, `reporter_email`) plus a JSON blob for extras → dashboard renders reporter on cards and thread header, filters by reporter.

**Tech Stack:** React 18, Express, better-sqlite3, Vitest + supertest.

---

## File Structure

- **`src/server/db.js`** — adds migration v3 (four columns + two indexes on `captures`).
- **`src/server/captures.js`** — `createCapture`, `getCapture`, `listCaptures` understand a `reporter` field.
- **`src/server/routes.js`** — `POST /api/captures` validates and forwards `reporter`; `GET /api/captures` accepts `reporter_id` filter.
- **`src/react/DevPanel.jsx`** — new optional `user` prop, forwarded in the capture POST body.
- **`src/dashboard/views/captures-view.jsx`** — shows reporter on capture cards + thread header, reporter filter dropdown.
- **`tests/server/db-reporter-migration.test.js`** *(new)* — migration v3 is idempotent, adds columns and indexes.
- **`tests/server/captures-reporter.test.js`** *(new)* — createCapture stores/returns reporter; listCaptures filters by `reporter_id`.
- **`tests/server/routes-captures-reporter.test.js`** *(new)* — POST validation, round-trip, GET filter.
- **`tests/react/devpanel-reporter.test.jsx`** *(new)* — widget forwards `user` as `reporter` in request body; omits when absent.

---

## Task 1: Database migration v3

**Files:**
- Modify: `src/server/db.js` (migration block after v2 at ~line 278)
- Create: `tests/server/db-reporter-migration.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/server/db-reporter-migration.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { initMasterDatabase, closeAllDatabases } from '../../src/server/db.js';

describe('captures reporter migration (v3)', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-repmig-'));
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('adds reporter_id, reporter_name, reporter_email, reporter_extra columns to captures', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    const cols = new Set(raw.prepare('PRAGMA table_info(captures)').all().map(c => c.name));
    expect(cols.has('reporter_id')).toBe(true);
    expect(cols.has('reporter_name')).toBe(true);
    expect(cols.has('reporter_email')).toBe(true);
    expect(cols.has('reporter_extra')).toBe(true);
  });

  it('creates idx_captures_reporter_id and idx_captures_reporter_email indexes', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    const idx = new Set(raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='captures'`
    ).all().map(r => r.name));
    expect(idx.has('idx_captures_reporter_id')).toBe(true);
    expect(idx.has('idx_captures_reporter_email')).toBe(true);
  });

  it('bumps user_version to at least 3', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    const v = raw.pragma('user_version', { simple: true });
    expect(v).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent: running init twice does not throw', () => {
    initMasterDatabase(tmp);
    closeAllDatabases();
    expect(() => initMasterDatabase(tmp)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run tests/server/db-reporter-migration.test.js`
Expected: FAIL — columns don't exist yet.

- [ ] **Step 3: Add migration v3 to `src/server/db.js`**

After the v2 block (around line 285, right before `return masterDb;`), add:

```js
  // Migration v3: reporter identity on captures.
  // Four nullable columns + two indexes. Splits the common fields (id/name/email)
  // into columns for filtering, keeps any extra host-provided fields as JSON
  // in reporter_extra. Guarded by user_version. See spec:
  // docs/superpowers/specs/2026-04-24-widget-reporter-identity-design.md
  const currentVersion3 = masterDb.pragma('user_version', { simple: true });
  if (currentVersion3 < 3) {
    const capCols = new Set(masterDb.prepare("PRAGMA table_info(captures)").all().map(c => c.name));
    if (!capCols.has('reporter_id'))    masterDb.exec(`ALTER TABLE captures ADD COLUMN reporter_id TEXT`);
    if (!capCols.has('reporter_name'))  masterDb.exec(`ALTER TABLE captures ADD COLUMN reporter_name TEXT`);
    if (!capCols.has('reporter_email')) masterDb.exec(`ALTER TABLE captures ADD COLUMN reporter_email TEXT`);
    if (!capCols.has('reporter_extra')) masterDb.exec(`ALTER TABLE captures ADD COLUMN reporter_extra TEXT`);
    masterDb.exec(`CREATE INDEX IF NOT EXISTS idx_captures_reporter_id    ON captures(reporter_id)`);
    masterDb.exec(`CREATE INDEX IF NOT EXISTS idx_captures_reporter_email ON captures(reporter_email)`);
    masterDb.pragma(`user_version = 3`);
  }
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run tests/server/db-reporter-migration.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/db.js tests/server/db-reporter-migration.test.js
git commit -m "feat(db): add reporter columns migration v3 on captures"
```

---

## Task 2: `createCapture`, `getCapture`, `listCaptures` accept and return reporter

**Files:**
- Modify: `src/server/captures.js` (functions `createCapture`, `getCapture`, `listCaptures`)
- Create: `tests/server/captures-reporter.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/server/captures-reporter.test.js`:

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

describe('captures reporter identity', () => {
  let tmp, project;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-reporter-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo' });
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('stores reporter id/name/email in columns when createCapture receives reporter', () => {
    const cap = createCapture({
      project_id: project.id,
      content: 'bug on page 7',
      kind: 'bug',
      reporter: { id: 'u_42', name: 'Alice', email: 'alice@zeno.com' }
    });
    expect(cap.reporter_id).toBe('u_42');
    expect(cap.reporter_name).toBe('Alice');
    expect(cap.reporter_email).toBe('alice@zeno.com');
  });

  it('stores non-standard reporter fields in reporter_extra JSON', () => {
    const cap = createCapture({
      project_id: project.id,
      content: 'x',
      reporter: { id: 'u_1', name: 'A', email: 'a@x', role: 'pm', team: 'core' }
    });
    const extras = JSON.parse(cap.reporter_extra);
    expect(extras).toEqual({ role: 'pm', team: 'core' });
  });

  it('leaves reporter columns null when reporter is not passed', () => {
    const cap = createCapture({ project_id: project.id, content: 'x' });
    expect(cap.reporter_id).toBeNull();
    expect(cap.reporter_name).toBeNull();
    expect(cap.reporter_email).toBeNull();
    expect(cap.reporter_extra).toBeNull();
  });

  it('truncates reporter fields to 255 chars', () => {
    const long = 'x'.repeat(300);
    const cap = createCapture({
      project_id: project.id,
      content: 'x',
      reporter: { id: long, name: long, email: long }
    });
    expect(cap.reporter_id.length).toBe(255);
    expect(cap.reporter_name.length).toBe(255);
    expect(cap.reporter_email.length).toBe(255);
  });

  it('getCapture returns a `reporter` object assembled from columns + extras', () => {
    const created = createCapture({
      project_id: project.id,
      content: 'x',
      reporter: { id: 'u_1', name: 'A', email: 'a@x', role: 'pm' }
    });
    const full = getCapture(created.id);
    expect(full.reporter).toEqual({ id: 'u_1', name: 'A', email: 'a@x', role: 'pm' });
  });

  it('getCapture returns reporter=null when no reporter was stored', () => {
    const created = createCapture({ project_id: project.id, content: 'x' });
    const full = getCapture(created.id);
    expect(full.reporter).toBeNull();
  });

  it('listCaptures filters by reporter_id', () => {
    createCapture({ project_id: project.id, content: 'a', reporter: { id: 'u_1', name: 'A' } });
    createCapture({ project_id: project.id, content: 'b', reporter: { id: 'u_2', name: 'B' } });
    createCapture({ project_id: project.id, content: 'c' });
    const filtered = listCaptures({ project_id: project.id, reporter_id: 'u_1' });
    expect(filtered.length).toBe(1);
    expect(filtered[0].content).toBe('a');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run tests/server/captures-reporter.test.js`
Expected: FAIL — `createCapture` ignores `reporter`.

- [ ] **Step 3: Update `src/server/captures.js`**

Replace `createCapture` with:

```js
export function createCapture({ project_id, content, kind = 'idea', created_by = 'franck', reporter = null }) {
  const db = getMasterDatabase();
  const id = randomUUID();

  const rep = normalizeReporter(reporter);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO captures
         (id, project_id, kind, content, status, created_by,
          reporter_id, reporter_name, reporter_email, reporter_extra)
       VALUES (?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)`
    ).run(
      id, project_id, kind, content, created_by,
      rep.id, rep.name, rep.email, rep.extra
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

// Split a host-provided reporter object into column values + a JSON extras
// blob. Returns { id, name, email, extra } with all fields string|null.
// Non-object input → all nulls. Fields truncated to 255 chars.
function normalizeReporter(reporter) {
  const empty = { id: null, name: null, email: null, extra: null };
  if (!reporter || typeof reporter !== 'object' || Array.isArray(reporter)) return empty;
  const trunc = (v) => (v == null ? null : String(v).slice(0, 255));
  const { id = null, name = null, email = null, ...rest } = reporter;
  const extraKeys = Object.keys(rest);
  const extra = extraKeys.length ? JSON.stringify(rest) : null;
  return { id: trunc(id), name: trunc(name), email: trunc(email), extra };
}
```

Replace `getCapture` with:

```js
export function getCapture(id) {
  const db = getMasterDatabase();
  const capture = db.prepare(`SELECT * FROM captures WHERE id = ?`).get(id);
  if (!capture) return null;
  const thread = db.prepare(
    `SELECT thread_id FROM threads WHERE subject_type='capture' AND subject_id=?`
  ).get(id);
  const messages = thread
    ? listMessages(thread.thread_id).map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        metadata: m.metadata ?? null,
        created_at: m.created_at
      }))
    : [];
  return { ...capture, reporter: assembleReporter(capture), messages };
}

// Build a single reporter object from the four columns. null if no
// reporter fields were populated.
function assembleReporter(row) {
  const { reporter_id, reporter_name, reporter_email, reporter_extra } = row;
  if (!reporter_id && !reporter_name && !reporter_email && !reporter_extra) return null;
  let extras = {};
  if (reporter_extra) {
    try { extras = JSON.parse(reporter_extra) || {}; } catch { extras = {}; }
  }
  return {
    ...(reporter_id    ? { id: reporter_id }       : {}),
    ...(reporter_name  ? { name: reporter_name }   : {}),
    ...(reporter_email ? { email: reporter_email } : {}),
    ...extras
  };
}
```

Replace `listCaptures` with:

```js
export function listCaptures({ project_id, status = null, reporter_id = null, limit = 100 }) {
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
  sql += ` ORDER BY c.updated_at DESC, c.created_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run tests/server/captures-reporter.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Re-run existing captures tests to verify no regression**

Run: `npx vitest run tests/server/captures.test.js`
Expected: PASS (unchanged count).

- [ ] **Step 6: Commit**

```bash
git add src/server/captures.js tests/server/captures-reporter.test.js
git commit -m "feat(captures): accept and return reporter identity"
```

---

## Task 3: Route `POST /api/captures` accepts `reporter`, `GET` filters by `reporter_id`

**Files:**
- Modify: `src/server/routes.js` (POST /captures at ~line 782, GET /captures at ~line 795)
- Create: `tests/server/routes-captures-reporter.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/server/routes-captures-reporter.test.js`:

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

describe('POST/GET /api/captures reporter', () => {
  let tmp, project, app;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-rrep-'));
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

  it('stores reporter when provided', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', reporter: { id: 'u_1', name: 'Alice', email: 'a@x' } });
    expect(res.status).toBe(201);
    expect(res.body.reporter_id).toBe('u_1');

    const list = await request(app).get('/api/captures').set('X-API-Key', project.api_key);
    expect(list.body.captures[0].reporter_id).toBe('u_1');
  });

  it('accepts captures without reporter (backward compat)', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x' });
    expect(res.status).toBe(201);
    expect(res.body.reporter_id).toBeNull();
  });

  it('rejects reporter that is not an object (string)', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', reporter: 'alice' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reporter/i);
  });

  it('rejects reporter that is an array', async () => {
    const res = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x', reporter: ['a', 'b'] });
    expect(res.status).toBe(400);
  });

  it('GET /captures?reporter_id=u_1 filters', async () => {
    const post = (body) => request(app).post('/api/captures').set('X-API-Key', project.api_key).send(body);
    await post({ content: 'a', reporter: { id: 'u_1', name: 'A' } });
    await post({ content: 'b', reporter: { id: 'u_2', name: 'B' } });
    await post({ content: 'c' });

    const r = await request(app)
      .get('/api/captures?reporter_id=u_1')
      .set('X-API-Key', project.api_key);
    expect(r.status).toBe(200);
    expect(r.body.captures.length).toBe(1);
    expect(r.body.captures[0].content).toBe('a');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run tests/server/routes-captures-reporter.test.js`
Expected: FAIL — route ignores reporter.

- [ ] **Step 3: Update `POST /captures` and `GET /captures` in `src/server/routes.js`**

Replace the `POST /captures` handler (around line 782):

```js
  router.post('/captures', authenticateProject, (req, res) => {
    try {
      const { content = '', kind = 'idea', reporter } = req.body || {};
      if (!String(content).trim()) return res.status(400).json({ error: 'content required' });
      if (reporter !== undefined && reporter !== null) {
        if (typeof reporter !== 'object' || Array.isArray(reporter)) {
          return res.status(400).json({ error: 'reporter must be an object' });
        }
      }
      const capture = createCapture({
        project_id: req.project.id,
        content: String(content).slice(0, 4000),
        kind: String(kind).slice(0, 32),
        reporter: reporter ?? null
      });
      res.status(201).json(capture);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
```

Replace the `GET /captures` handler (around line 795):

```js
  router.get('/captures', authenticateProject, (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : null;
      const reporter_id = req.query.reporter_id ? String(req.query.reporter_id) : null;
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
      res.json({ captures: listCaptures({ project_id: req.project.id, status, reporter_id, limit }) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run tests/server/routes-captures-reporter.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Re-run full server test suite to catch regressions**

Run: `npx vitest run tests/server/`
Expected: All pre-existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes.js tests/server/routes-captures-reporter.test.js
git commit -m "feat(api): accept reporter on captures POST, filter on GET"
```

---

## Task 4: Widget forwards `user` prop as `reporter`

**Files:**
- Modify: `src/react/DevPanel.jsx` (props signature ~line 21; `postCapture` ~line 110)
- Create: `tests/react/devpanel-reporter.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `tests/react/devpanel-reporter.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { DevPanel } from '../../src/react/DevPanel.jsx';

describe('DevPanel reporter forwarding', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: 'cap_1' })
    }));
    // jsdom doesn't implement navigator.mediaDevices; stub so the widget mounts.
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

  it('includes reporter in the POST body when `user` prop is passed', async () => {
    const body = await openBugFormAndSubmit({
      user: { id: 'u_42', name: 'Alice', email: 'alice@zeno.com', role: 'pm' }
    });
    expect(body.reporter).toEqual({ id: 'u_42', name: 'Alice', email: 'alice@zeno.com', role: 'pm' });
  });

  it('omits reporter when `user` prop is not passed', async () => {
    const body = await openBugFormAndSubmit({});
    expect(body.reporter).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run tests/react/devpanel-reporter.test.jsx`
Expected: FAIL — widget doesn't forward `user`.

- [ ] **Step 3: Update `src/react/DevPanel.jsx`**

Change the component signature and `postCapture`:

```jsx
export function DevPanel({
  apiUrl = 'http://localhost:3030',
  apiKey,
  position = 'bottom-right',
  getState = null,
  user = null
}) {
```

Replace the `postCapture` body (around line 110):

```js
  const postCapture = useCallback(async ({ kind, content, metadata }) => {
    const payload = { kind, content };
    if (user && typeof user === 'object' && !Array.isArray(user)) {
      payload.reporter = user;
    }
    const createRes = await fetch(`${apiUrl}/api/captures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify(payload)
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
  }, [apiUrl, apiKey, user]);
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run tests/react/devpanel-reporter.test.jsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/react/DevPanel.jsx tests/react/devpanel-reporter.test.jsx
git commit -m "feat(widget): forward host-app user as reporter"
```

---

## Task 5: Dashboard — reporter on cards and thread header

**Files:**
- Modify: `src/dashboard/views/captures-view.jsx`

No dedicated automated test — the dashboard uses no React Testing Library today and a manual browser check (see Step 4) is the existing convention for visual work.

- [ ] **Step 1: Add a reporter label to the capture list card**

In `src/dashboard/views/captures-view.jsx`, inside the `list.map((c, i) => { ... })` block (around line 201, the `<div className="flex items-center gap-2 mb-1.5">` row), add a reporter pill before the time:

Replace:

```jsx
                <div className="flex items-center gap-2 mb-1.5">
                  <StatusChip status={c.status} />
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
                  <span className="text-[10.5px] text-[var(--color-foreground-faint)] font-mono ml-auto">{timeAgo(c.updated_at)}</span>
                </div>
```

- [ ] **Step 2: Add reporter line to the thread header**

In the thread header block (around line 229, `<div className="h-11 px-5 ...">`), add a reporter span. Replace:

```jsx
              <div className="h-11 px-5 flex items-center gap-3 border-b border-[var(--color-border-subtle)] shrink-0">
                <StatusChip status={thread.status} />
                <span className="text-[11.5px] font-mono text-[var(--color-foreground-faint)]">
                  {thread.kind} · {timeAgo(thread.created_at)}
                </span>
                {thread.plane_sequence_id && (
                  <span className="text-[11.5px] text-[var(--color-success)] font-mono">→ DEVPA-{thread.plane_sequence_id}</span>
                )}
```

With:

```jsx
              <div className="h-11 px-5 flex items-center gap-3 border-b border-[var(--color-border-subtle)] shrink-0">
                <StatusChip status={thread.status} />
                <span className="text-[11.5px] font-mono text-[var(--color-foreground-faint)]">
                  {thread.kind} · {timeAgo(thread.created_at)}
                </span>
                {(thread.reporter_name || thread.reporter_email) && (
                  <span className="text-[11.5px] text-[var(--color-foreground-muted)]">
                    by {thread.reporter_name || thread.reporter_email}
                    {thread.reporter_email && thread.reporter_name ? ` (${thread.reporter_email})` : ''}
                  </span>
                )}
                {thread.plane_sequence_id && (
                  <span className="text-[11.5px] text-[var(--color-success)] font-mono">→ DEVPA-{thread.plane_sequence_id}</span>
                )}
```

- [ ] **Step 3: Add reporter filter dropdown**

Add a reporter filter state near the other `useState` declarations (around line 36):

```jsx
  const [reporterFilter, setReporterFilter] = useState('');
```

Update `loadList` to include the filter (around line 45):

```jsx
  const loadList = useCallback(async () => {
    if (!apiKey) return;
    try {
      const qs = reporterFilter ? `?reporter_id=${encodeURIComponent(reporterFilter)}` : '';
      const r = await fetch(`${apiUrl}/api/captures${qs}`, { headers: { 'X-API-Key': apiKey } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { captures } = await r.json();
      setList(captures);
      setError(null);
    } catch (e) { setError(e.message); }
  }, [apiUrl, apiKey, reporterFilter]);
```

Derive the list of distinct reporters from the loaded list (compute right after `counts`, around line 142):

```jsx
  const reporters = Array.from(
    list.reduce((m, c) => {
      if (c.reporter_id) m.set(c.reporter_id, c.reporter_name || c.reporter_email || c.reporter_id);
      return m;
    }, new Map())
  );
```

Note: when `reporterFilter` is active the list is already filtered and the dropdown would shrink to a single item. Keep the full list for the dropdown by loading it from a separate cache.

Update the `loadList` to keep an always-unfiltered copy for the dropdown. Replace the block with:

```jsx
  const [allList, setAllList] = useState([]);
  const loadList = useCallback(async () => {
    if (!apiKey) return;
    try {
      const full = await fetch(`${apiUrl}/api/captures`, { headers: { 'X-API-Key': apiKey } });
      if (!full.ok) throw new Error(`HTTP ${full.status}`);
      const fullBody = await full.json();
      setAllList(fullBody.captures);

      if (reporterFilter) {
        const r = await fetch(`${apiUrl}/api/captures?reporter_id=${encodeURIComponent(reporterFilter)}`, { headers: { 'X-API-Key': apiKey } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { captures } = await r.json();
        setList(captures);
      } else {
        setList(fullBody.captures);
      }
      setError(null);
    } catch (e) { setError(e.message); }
  }, [apiUrl, apiKey, reporterFilter]);
```

And derive `reporters` from `allList` instead:

```jsx
  const reporters = Array.from(
    allList.reduce((m, c) => {
      if (c.reporter_id) m.set(c.reporter_id, c.reporter_name || c.reporter_email || c.reporter_id);
      return m;
    }, new Map())
  );
```

Render the dropdown in the list header (around line 178, inside the `<div className="px-4 h-9 ...">`):

Replace:

```jsx
          <div className="px-4 h-9 flex items-center gap-2 text-[11px] uppercase tracking-wider font-semibold text-[var(--color-foreground-muted)] border-b border-[var(--color-border-subtle)] shrink-0">
            <span>{list.length} capture{list.length === 1 ? '' : 's'}</span>
            {counts.new      ? <span className="text-[var(--color-warning)] normal-case font-normal tracking-normal">· {counts.new} new</span>      : null}
            {counts.triaging ? <span className="text-[var(--color-info)] normal-case font-normal tracking-normal">· {counts.triaging} triaging</span> : null}
            {counts.promoted ? <span className="text-[var(--color-success)] normal-case font-normal tracking-normal">· {counts.promoted} promoted</span> : null}
          </div>
```

With:

```jsx
          <div className="px-4 h-9 flex items-center gap-2 text-[11px] uppercase tracking-wider font-semibold text-[var(--color-foreground-muted)] border-b border-[var(--color-border-subtle)] shrink-0">
            <span>{list.length} capture{list.length === 1 ? '' : 's'}</span>
            {counts.new      ? <span className="text-[var(--color-warning)] normal-case font-normal tracking-normal">· {counts.new} new</span>      : null}
            {counts.triaging ? <span className="text-[var(--color-info)] normal-case font-normal tracking-normal">· {counts.triaging} triaging</span> : null}
            {counts.promoted ? <span className="text-[var(--color-success)] normal-case font-normal tracking-normal">· {counts.promoted} promoted</span> : null}
            {reporters.length > 0 && (
              <select
                value={reporterFilter}
                onChange={(e) => setReporterFilter(e.target.value)}
                className="ml-auto text-[11px] bg-transparent border border-[var(--color-border-subtle)] rounded px-1 py-0.5 normal-case font-normal tracking-normal"
              >
                <option value="">all reporters</option>
                {reporters.map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
            )}
          </div>
```

- [ ] **Step 4: Manual browser check**

Start the API server and dashboard, then in a test host page include the widget with a `user` prop and submit a capture. Open the dashboard Inbox and confirm:
- The capture card shows the reporter name next to the status chip.
- The thread header shows "by Alice (alice@zeno.com)".
- The filter dropdown appears and filtering to the reporter's id narrows the list to that reporter's captures.

Submit a second capture without a `user` prop and confirm it still appears (no reporter shown), and that the filter dropdown still contains only the one known reporter.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/views/captures-view.jsx
git commit -m "feat(dashboard): show and filter by capture reporter"
```

---

## Task 6: Rebuild the widget bundle and verify integration

**Files:**
- Modify: `dist/widget.js` (generated artifact)

- [ ] **Step 1: Build the widget**

Run: `npm run build:widget` (or whatever script produces `dist/widget.js`; check `package.json` `"scripts"` for the exact name — if absent, invoke the same bundler used previously in git history, e.g. `npx esbuild src/react/DevPanel.jsx --bundle --outfile=dist/widget.js --format=esm`).

Expected: `dist/widget.js` rebuilt, updated timestamp.

- [ ] **Step 2: Confirm the built bundle references reporter**

Run: `grep -c reporter dist/widget.js`
Expected: at least 1 match.

- [ ] **Step 3: Commit the rebuilt widget**

```bash
git add dist/widget.js
git commit -m "chore(widget): rebuild bundle with reporter support"
```

---

## Self-Review

Cross-checking the plan against the spec:

1. **Spec §1 Widget API** → Task 4 adds the `user` prop.
2. **Spec §2 API contract** → Task 3 adds validation + `reporter_id` filter.
3. **Spec §3 Database migration v3** → Task 1.
4. **Spec §4 Capture module** → Task 2 (normalize, assemble, filter).
5. **Spec §5 Dashboard** → Task 5 (card label, thread header, filter dropdown).
6. **Spec §6 Backward compatibility** → covered by tests in Tasks 2, 3, 4 that assert no-reporter paths return nulls / undefined.

No placeholders, no TBDs in code, all paths absolute, test code and implementation code shown in full. `normalizeReporter` and `assembleReporter` names are consistent across their definition and usage. `reporter_id` is the field name used in SQL, route query param, and list filter argument everywhere.
