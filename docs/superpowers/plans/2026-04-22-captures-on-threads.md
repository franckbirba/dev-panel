# Captures on Threads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate capture conversations from `capture_messages` onto the generic `subjects` + `threads` + `thread_messages` model so dashboard replies push to Telegram and Shelly can reply through the same `[thread:<type>/<id>]` tag protocol she already uses for work items.

**Architecture:** A one-shot idempotent SQLite migration (guarded by `PRAGMA user_version`) copies existing `capture_messages` into `thread_messages`, then drops the old table. The server's capture routes either delegate to threads (POST messages) or rewrite their read path to read from `thread_messages` via a thread join. The dashboard's `captures-view.jsx` changes two fetch call sites. SOUL gets one protocol line. Everything runs in the existing devpanel container.

**Tech Stack:** Node.js, Express, better-sqlite3, Vitest, React (for the dashboard view). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-22-captures-on-threads-design.md`

---

## File Structure

**Modified:**
- `src/server/db.js` — add the boot migration that backfills `thread_messages` from `capture_messages` and drops the old table. Guarded by `PRAGMA user_version`.
- `src/server/captures.js` — remove `addCaptureMessage()`. Rewrite `createCapture()` to also insert subject + thread + first thread_message in one transaction. Rewrite `getCapture()` and `listCaptures()` to read messages from `thread_messages`. Rewrite `deleteCapture()` to cascade-clean subject + thread rows.
- `src/server/routes.js` — delete `POST /api/captures/:id/messages`. Everything else in the captures block keeps the same URL.
- `src/server/signals.js` — rewrite the `last_role` subselect in the capture-producing query to read from `thread_messages` via `threads`.
- `src/dashboard/views/captures-view.jsx` — `handleReply()` posts to `/api/threads/capture/:id/messages` instead of `/api/captures/:id/messages`.
- `.agents/shelly/SOUL.md` — one-line protocol update in the "Captures" section.

**New tests:**
- `tests/server/captures.test.js` — unit + integration for migration, create/get/list/delete, and the thread-backed reply flow.

---

## Task 1: Failing integration test for backfill migration

**Files:**
- Create: `tests/server/captures.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/server/captures.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { initMasterDatabase, createProject, getMasterDatabase } from '../../src/server/db.js';

describe('captures migration (capture_messages → thread_messages)', () => {
  let tmp;
  let project;

  function bootWithLegacyData() {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-capmig-'));
    // First boot — create schema, insert project + legacy rows.
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });

    // Open the raw db to seed legacy rows before the migration runs.
    const raw = new Database(join(tmp, 'projects.db'));
    raw.exec(`PRAGMA user_version = 0`); // force migration to re-run on next boot
    raw.prepare(`
      INSERT INTO captures (id, project_id, kind, content, status, created_by)
      VALUES ('cap-1', ?, 'idea', 'first thought', 'triaging', 'franck')
    `).run(project.id);
    raw.prepare(`
      INSERT INTO capture_messages (capture_id, role, content, created_at)
      VALUES ('cap-1', 'user',   'first thought', '2026-04-21 10:00:00'),
             ('cap-1', 'shelly', 'got it, bug or feature?', '2026-04-21 10:01:00'),
             ('cap-1', 'user',   'bug', '2026-04-21 10:02:00')
    `).run();
    raw.close();
  }

  beforeEach(() => { bootWithLegacyData(); });

  it('backfills capture_messages into thread_messages and drops the old table', () => {
    // Second boot — migration should run.
    initMasterDatabase(tmp);
    const db = getMasterDatabase();

    const subj = db.prepare(
      `SELECT * FROM subjects WHERE subject_type='capture' AND subject_id='cap-1'`
    ).get();
    expect(subj).toBeTruthy();
    expect(subj.project_id).toBe(project.id);

    const thread = db.prepare(
      `SELECT * FROM threads WHERE subject_type='capture' AND subject_id='cap-1'`
    ).get();
    expect(thread).toBeTruthy();

    const msgs = db.prepare(
      `SELECT role, source, content FROM thread_messages
        WHERE thread_id=? ORDER BY id ASC`
    ).all(thread.thread_id);
    expect(msgs).toHaveLength(3);
    expect(msgs.map(m => m.role)).toEqual(['user', 'shelly', 'user']);
    expect(msgs.every(m => m.source === 'web')).toBe(true);
    expect(msgs[1].content).toBe('got it, bug or feature?');

    const captureMessagesExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='capture_messages'`
    ).get();
    expect(captureMessagesExists).toBeUndefined();
  });

  it('is idempotent: re-initialising on an already-migrated db is a no-op', () => {
    initMasterDatabase(tmp); // runs migration
    initMasterDatabase(tmp); // should be a no-op
    const db = getMasterDatabase();
    const msgs = db.prepare(
      `SELECT COUNT(*) AS n FROM thread_messages tm
         JOIN threads t ON t.thread_id=tm.thread_id
        WHERE t.subject_type='capture' AND t.subject_id='cap-1'`
    ).get();
    expect(msgs.n).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/captures.test.js`
Expected: FAIL — the migration code doesn't exist yet. Likely errors: `capture_messages` still exists after second boot, or `thread_messages` is empty.

---

## Task 2: Implement the boot migration

**Files:**
- Modify: `src/server/db.js`

- [ ] **Step 1: Find the end of the masterDb.exec() block that creates captures + capture_messages**

In `src/server/db.js`, locate the second `masterDb.exec(\`...\`)` block (around line 100-128), which ends with the `capture_messages` table and its index. The next block creates `subjects`, `threads`, `thread_messages`.

- [ ] **Step 2: Add the migration after all `CREATE TABLE IF NOT EXISTS` blocks have run**

Find the point in `initMasterDatabase` after all `masterDb.exec()` schema-creation blocks but before `return masterDb;`. Insert the migration there:

```javascript
  // Migration: move capture_messages into thread_messages + drop the old table.
  // Guarded by PRAGMA user_version — runs exactly once per database.
  // Spec: docs/superpowers/specs/2026-04-22-captures-on-threads-design.md
  const CAPTURES_ON_THREADS_VERSION = 1;
  const currentVersion = masterDb.pragma('user_version', { simple: true });
  if (currentVersion < CAPTURES_ON_THREADS_VERSION) {
    const captureMessagesTable = masterDb.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='capture_messages'`
    ).get();

    const migrate = masterDb.transaction(() => {
      if (captureMessagesTable) {
        // 1. Subjects: one row per existing capture.
        masterDb.prepare(`
          INSERT OR IGNORE INTO subjects (subject_type, subject_id, project_id, title)
          SELECT 'capture', id, project_id, substr(content, 1, 120) FROM captures
        `).run();

        // 2. Threads: one row per existing capture.
        masterDb.prepare(`
          INSERT OR IGNORE INTO threads (subject_type, subject_id, project_id)
          SELECT 'capture', id, project_id FROM captures
        `).run();

        // 3. Messages: copy every capture_messages row into thread_messages
        //    with source='web' (all pre-migration messages came from the dashboard).
        masterDb.prepare(`
          INSERT INTO thread_messages (thread_id, role, source, content, created_at)
          SELECT t.thread_id, cm.role, 'web', cm.content, cm.created_at
            FROM capture_messages cm
            JOIN threads t
              ON t.subject_type='capture' AND t.subject_id=cm.capture_id
           ORDER BY cm.id ASC
        `).run();

        // 4. Drop the old table.
        masterDb.exec(`DROP TABLE capture_messages`);
      }
      // 5. Bump version — always, even if there was nothing to migrate
      //    (fresh DB).
      masterDb.pragma(`user_version = ${CAPTURES_ON_THREADS_VERSION}`);
    });
    migrate();
  }
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx vitest run tests/server/captures.test.js`
Expected: PASS on both migration tests.

- [ ] **Step 4: Run the full server test suite to make sure nothing else broke**

Run: `npx vitest run tests/server/`
Expected: all tests pass (threads.test.js in particular must still pass).

- [ ] **Step 5: Commit**

```bash
git add src/server/db.js tests/server/captures.test.js
git commit -m "$(cat <<'EOF'
feat(db): migrate capture_messages into thread_messages

One-shot boot migration guarded by PRAGMA user_version: backfills every
capture_messages row as a source='web' thread_messages row under a
'capture' subject_type thread, then drops capture_messages. Idempotent.

Spec: docs/superpowers/specs/2026-04-22-captures-on-threads-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Failing test for rewritten createCapture / getCapture

**Files:**
- Modify: `tests/server/captures.test.js`

- [ ] **Step 1: Add a new `describe` block to the test file**

Append the following to `tests/server/captures.test.js`:

```javascript
import { createCapture, getCapture, listCaptures, deleteCapture } from '../../src/server/captures.js';

describe('captures (thread-backed)', () => {
  let project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-cap-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
  });

  it('createCapture seeds subject, thread, and a user message in thread_messages', () => {
    const cap = createCapture({ project_id: project.id, content: 'found a bug' });
    expect(cap.id).toBeTruthy();
    expect(cap.status).toBe('new');
    expect(cap.messages).toHaveLength(1);
    expect(cap.messages[0]).toMatchObject({ role: 'user', content: 'found a bug' });

    const db = getMasterDatabase();
    const subj = db.prepare(
      `SELECT * FROM subjects WHERE subject_type='capture' AND subject_id=?`
    ).get(cap.id);
    expect(subj).toBeTruthy();
    const thread = db.prepare(
      `SELECT * FROM threads WHERE subject_type='capture' AND subject_id=?`
    ).get(cap.id);
    expect(thread).toBeTruthy();
    const msgs = db.prepare(
      `SELECT role, source, content FROM thread_messages WHERE thread_id=?`
    ).all(thread.thread_id);
    expect(msgs).toEqual([{ role: 'user', source: 'web', content: 'found a bug' }]);
  });

  it('getCapture reads messages from thread_messages ordered by time', () => {
    const cap = createCapture({ project_id: project.id, content: 'hi' });
    // Simulate Shelly replying via the threads path.
    const { getOrCreateThread, appendMessage } = await import('../../src/server/threads.js');
    const t = getOrCreateThread('capture', cap.id);
    appendMessage({ thread_id: t.thread_id, role: 'shelly', source: 'telegram', content: 'yo' });

    const reloaded = getCapture(cap.id);
    expect(reloaded.messages).toHaveLength(2);
    expect(reloaded.messages[0]).toMatchObject({ role: 'user', content: 'hi' });
    expect(reloaded.messages[1]).toMatchObject({ role: 'shelly', content: 'yo' });
  });

  it('listCaptures returns message_count, last_message, last_role from thread_messages', () => {
    const cap = createCapture({ project_id: project.id, content: 'foo' });
    const { getOrCreateThread, appendMessage } = await import('../../src/server/threads.js');
    const t = getOrCreateThread('capture', cap.id);
    appendMessage({ thread_id: t.thread_id, role: 'shelly', source: 'telegram', content: 'bar' });

    const list = listCaptures({ project_id: project.id });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: cap.id,
      message_count: 2,
      last_message: 'bar',
      last_role: 'shelly'
    });
  });

  it('deleteCapture cascades subject + thread + messages', () => {
    const cap = createCapture({ project_id: project.id, content: 'doomed' });
    deleteCapture(cap.id);

    const db = getMasterDatabase();
    expect(db.prepare(`SELECT 1 FROM captures WHERE id=?`).get(cap.id)).toBeUndefined();
    expect(db.prepare(
      `SELECT 1 FROM subjects WHERE subject_type='capture' AND subject_id=?`
    ).get(cap.id)).toBeUndefined();
    expect(db.prepare(
      `SELECT 1 FROM threads WHERE subject_type='capture' AND subject_id=?`
    ).get(cap.id)).toBeUndefined();
    expect(db.prepare(
      `SELECT COUNT(*) AS n FROM thread_messages`
    ).get().n).toBe(0);
  });
});
```

Note: the two `await import(...)` calls must be inside `async` test functions. Fix the `it(...)` lines that use them to `it('...', async () => { ... })`.

- [ ] **Step 2: Fix the async `it` declarations**

For the two tests using `await import`, change `it('...', () => {` to `it('...', async () => {`. Apply to:
- `it('getCapture reads messages from thread_messages ordered by time', async () => {`
- `it('listCaptures returns message_count, last_message, last_role from thread_messages', async () => {`

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/server/captures.test.js`
Expected: FAIL — `createCapture` still writes to `capture_messages` (which was dropped), or `getCapture` returns empty `messages`, or `deleteCapture` doesn't clean subjects/threads.

---

## Task 4: Rewrite captures.js to use threads

**Files:**
- Modify: `src/server/captures.js`

- [ ] **Step 1: Replace the entire file contents**

```javascript
// src/server/captures.js
//
// Franck + Shelly's triage surface. A capture is a raw thought Franck
// dumps into the dashboard or Telegram — a bug he noticed, a feature he
// wants, a half-formed idea. Shelly picks it up, asks clarifying questions,
// and when the item is ripe she promotes it to a Plane work item
// (populating plane_work_item_id + plane_sequence_id).
//
// Lifecycle:
//   new        — just captured, Shelly has not triaged yet
//   triaging   — Shelly is asking questions, awaiting Franck's reply
//   promoted   — turned into a Plane work item (see plane_*)
//   dropped    — decided not to pursue; kept for the record
//
// Messages live in thread_messages under subject_type='capture'. Replies
// posted via POST /api/threads/capture/:id/messages push to Telegram so
// Shelly hears them.

import { randomUUID } from 'crypto';
import { getMasterDatabase } from './db.js';
import { upsertSubject } from './subjects.js';
import { getOrCreateThread, appendMessage, listMessages } from './threads.js';

export function createCapture({ project_id, content, kind = 'idea', created_by = 'franck' }) {
  const db = getMasterDatabase();
  const id = randomUUID();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO captures (id, project_id, kind, content, status, created_by)
       VALUES (?, ?, ?, ?, 'new', ?)`
    ).run(id, project_id, kind, content, created_by);

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
        metadata: null,
        created_at: m.created_at
      }))
    : [];
  return { ...capture, messages };
}

export function listCaptures({ project_id, status = null, limit = 100 }) {
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
  if (status) { sql += ` AND c.status = ?`; params.push(status); }
  sql += ` ORDER BY c.updated_at DESC, c.created_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function listPendingForAllProjects({ limit = 50 } = {}) {
  const db = getMasterDatabase();
  return db.prepare(`
    SELECT c.*, p.name AS project_name
      FROM captures c
      JOIN projects p ON p.id = c.project_id
     WHERE c.status IN ('new', 'triaging')
     ORDER BY c.created_at ASC
     LIMIT ?
  `).all(limit);
}

export function updateCapture(id, patch) {
  const db = getMasterDatabase();
  const allowed = ['status', 'kind', 'plane_work_item_id', 'plane_sequence_id'];
  const fields = [], values = [];
  for (const k of allowed) {
    if (k in patch) { fields.push(`${k} = ?`); values.push(patch[k]); }
  }
  if (!fields.length) return getCapture(id);
  fields.push(`updated_at = CURRENT_TIMESTAMP`);
  db.prepare(`UPDATE captures SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
  return getCapture(id);
}

export function deleteCapture(id) {
  const db = getMasterDatabase();
  const tx = db.transaction(() => {
    // threads cascades to thread_messages. subjects is independent.
    db.prepare(
      `DELETE FROM threads WHERE subject_type='capture' AND subject_id=?`
    ).run(id);
    db.prepare(
      `DELETE FROM subjects WHERE subject_type='capture' AND subject_id=?`
    ).run(id);
    db.prepare(`DELETE FROM captures WHERE id = ?`).run(id);
  });
  tx();
}
```

Note: `addCaptureMessage` is intentionally gone. There's a `metadata: null` in the return shape of `getCapture` to preserve the old response contract for clients that read `messages[].metadata`.

- [ ] **Step 2: Run the new tests**

Run: `npx vitest run tests/server/captures.test.js`
Expected: all tests pass, including Task 1's migration tests and Task 3's thread-backed captures tests.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run tests/`
Expected: every existing test still passes. If a test uses `addCaptureMessage` directly, it will fail — rewrite it to use the threads module.

- [ ] **Step 4: Commit**

```bash
git add src/server/captures.js tests/server/captures.test.js
git commit -m "$(cat <<'EOF'
feat(captures): read/write messages via thread_messages

createCapture now inserts the subject, thread, and first user message in
one transaction. getCapture/listCaptures read messages from thread_messages
joined on subject_type='capture'. deleteCapture explicitly cascades to
subjects + threads (FKs only cascade from projects, not from captures).
addCaptureMessage removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Remove the POST /api/captures/:id/messages route

**Files:**
- Modify: `src/server/routes.js`

- [ ] **Step 1: Find and delete the POST messages route**

In `src/server/routes.js`, delete the block starting at `router.post('/captures/:id/messages', authenticateProject, (req, res) => {` and ending at its closing `});` (roughly lines 740–755).

Also remove `addCaptureMessage` from the import at the top of the file (around line 18):

```javascript
// Before:
import {
  // ...
  addCaptureMessage,
  // ...
} from './captures.js';

// After: (addCaptureMessage removed)
```

- [ ] **Step 2: Update the comment block above the captures routes**

Find the comment block that starts `// CAPTURES — Franck+Shelly's triage surface` (around line 700). Remove the line `//   POST /captures/:id/messages    append a user message` and add a reference to threads:

```javascript
  // ============================================================================
  // CAPTURES — Franck+Shelly's triage surface. Pre-Plane queue.
  //   POST /captures                 create (content, optional kind)
  //   GET  /captures                 list for the current project
  //   GET  /captures/:id             capture + messages (thread)
  //   PATCH /captures/:id            mutate status / attach plane ids
  //   DELETE /captures/:id           drop
  //
  // To reply in a capture's thread, use POST /threads/capture/:id/messages —
  // that path handles SSE broadcast + Telegram forwarding for Shelly.
  // All project-key auth — captures belong to a project.
  // ============================================================================
```

- [ ] **Step 3: Add an integration test that posting to /threads/capture/:id works end-to-end**

Append to `tests/server/captures.test.js`:

```javascript
import request from 'supertest';
import { createServer } from '../../src/server/index.js';

describe('captures HTTP integration', () => {
  let app, project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-caphttp-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
    app = createServer();
  });

  it('POST /api/threads/capture/:id/messages appends to the capture thread', async () => {
    const created = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'test bug' });
    expect(created.status).toBe(201);
    const cap = created.body;

    const reply = await request(app)
      .post(`/api/threads/capture/${cap.id}/messages`)
      .set('X-API-Key', project.api_key)
      .send({ content: 'me too' });
    expect(reply.status).toBe(200);

    const reloaded = await request(app)
      .get(`/api/captures/${cap.id}`)
      .set('X-API-Key', project.api_key);
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.messages).toHaveLength(2);
    expect(reloaded.body.messages[1].content).toBe('me too');
  });

  it('POST /api/captures/:id/messages is gone (404)', async () => {
    const created = await request(app)
      .post('/api/captures')
      .set('X-API-Key', project.api_key)
      .send({ content: 'x' });
    const gone = await request(app)
      .post(`/api/captures/${created.body.id}/messages`)
      .set('X-API-Key', project.api_key)
      .send({ content: 'y' });
    expect(gone.status).toBe(404);
  });
});
```

Check whether `supertest` is already a dev-dependency:
Run: `node -e "console.log(require('./package.json').devDependencies?.supertest || 'MISSING')"`
If it prints `MISSING`, install it:
Run: `npm install --save-dev supertest`

Also verify the subjects module allows `capture` before first write — it does (see `src/server/subjects.js` line 9), so the `/api/threads/capture/:id/messages` endpoint will create the thread via `getOrCreateThread`, which requires the subject to exist. Because `createCapture` now upserts the subject, this works.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/server/captures.test.js`
Expected: all tests pass, including the HTTP integration tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes.js tests/server/captures.test.js package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat(api): drop POST /api/captures/:id/messages

Replies now go through POST /api/threads/capture/:id/messages, which
already handles SSE broadcast + Telegram forwarding with the
[thread:capture/<id>] tag Shelly understands.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Update signals.js capture query

**Files:**
- Modify: `src/server/signals.js:57-67` (the capture-producing block)

- [ ] **Step 1: Replace the capture query**

Find the `// --- captures ---` block (around line 57). Replace the SQL:

```javascript
  // --- captures ---
  const captureRows = db.prepare(`
    SELECT c.*, p.name AS project_name,
           (SELECT tm.role FROM thread_messages tm
              JOIN threads t ON t.thread_id=tm.thread_id
             WHERE t.subject_type='capture' AND t.subject_id=c.id
             ORDER BY tm.created_at DESC LIMIT 1) AS last_role
      FROM captures c
      JOIN projects p ON p.id = c.project_id
     WHERE c.status IN ('new', 'triaging')
       AND c.created_at >= ?
       ${project_id ? 'AND c.project_id = ?' : ''}
  `).all(...(project_id ? [sinceIso, project_id] : [sinceIso]));
```

- [ ] **Step 2: Smoke test the signals endpoint**

If there is an existing signals test, run it:
Run: `npx vitest run tests/server/signals.test.js 2>/dev/null || echo "no signals test yet"`
If no test exists, manually verify by booting the server and hitting the signals endpoint (smoke-only — no new tests required for this one-line change).

- [ ] **Step 3: Commit**

```bash
git add src/server/signals.js
git commit -m "$(cat <<'EOF'
fix(signals): read capture last_role from thread_messages

capture_messages no longer exists after the boot migration.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Point captures-view.jsx at the threads endpoint

**Files:**
- Modify: `src/dashboard/views/captures-view.jsx:102`

- [ ] **Step 1: Find `handleReply` and change the fetch URL**

In `src/dashboard/views/captures-view.jsx`, find `handleReply` (around line 96). Change this one line:

```javascript
      await fetch(`${apiUrl}/api/captures/${selected}/messages`, {
```

to:

```javascript
      await fetch(`${apiUrl}/api/threads/capture/${selected}/messages`, {
```

The request body stays the same: `{ content, role: 'user' }`. The threads endpoint accepts `{ content }` and defaults role to `user`, so the `role` field is ignored but harmless.

- [ ] **Step 2: Verify the build still works**

Run: `npm run build`
Expected: Vite build succeeds with no errors in `captures-view.jsx`.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/views/captures-view.jsx
git commit -m "$(cat <<'EOF'
feat(dashboard): reply to captures via the threads endpoint

Replies now push to Telegram with the [thread:capture/<id>] tag Shelly
already handles.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Update Shelly's SOUL with the capture reply protocol

**Files:**
- Modify: `.agents/shelly/SOUL.md` (the Captures section)

- [ ] **Step 1: Find the "Captures — la surface de triage" section**

In `.agents/shelly/SOUL.md`, find the section starting with `## Captures — la surface de triage entre Franck et toi`.

- [ ] **Step 2: Update the transport bullet**

Replace the line:
```
- **Tes réponses :** `POST /api/captures/:id/messages` avec `role: "shelly"`. Chaque réponse passe la capture de `new` → `triaging`.
```

with:
```
- **Tes réponses :** `POST /api/threads/capture/:id/messages` avec `content` (role défaulte à `shelly` côté MCP). Chaque réponse passe la capture de `new` → `triaging` automatiquement. Tu peux aussi répondre depuis Telegram en préfixant avec `[thread:capture/<id>]` — même protocole que pour les work items.
```

- [ ] **Step 3: Deploy the updated SOUL**

The SOUL is auto-loaded by Shelly via the `@` include in `CLAUDE.md`. A deploy will rsync the repo to the agents host, and next time Shelly's session restarts she'll pick up the new SOUL. No manual deploy script needed for this PR — it rides along with the next `git push` to main.

- [ ] **Step 4: Commit**

```bash
git add .agents/shelly/SOUL.md
git commit -m "$(cat <<'EOF'
docs(shelly): capture replies go through /api/threads/capture/:id/messages

The old /api/captures/:id/messages endpoint is gone. Same triage rules,
new transport — consistent with how Shelly already replies to work items.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Manual verification & PR

- [ ] **Step 1: Run the full test suite one more time**

Run: `npx vitest run`
Expected: everything green.

- [ ] **Step 2: Push and open a PR**

```bash
git push -u origin HEAD
gh pr create --title "Captures on threads — push replies to Telegram" --body "$(cat <<'EOF'
## Summary
- Migrate capture_messages → thread_messages (one-shot SQLite migration, guarded by PRAGMA user_version).
- Drop POST /api/captures/:id/messages; the dashboard now calls POST /api/threads/capture/:id/messages.
- That path already forwards to Telegram with `[thread:capture/<id>]` — Shelly hears Franck's capture replies for the first time.

Spec: `docs/superpowers/specs/2026-04-22-captures-on-threads-design.md`.

## Test plan
- [ ] `npx vitest run` green
- [ ] Deploy to services VPS via `git push origin main` (CI-scoped to the devpanel container).
- [ ] Open the dashboard Inbox, create a capture, post a reply.
- [ ] Verify Telegram receives `[thread:capture/<id>] <reply content>`.
- [ ] Shelly replies in Telegram; dashboard thread shows her message via SSE (or 8s poll).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: After merge, monitor the first capture interaction**

After CI deploys, post a capture from the dashboard and verify:
1. The message appears under the capture thread in the dashboard.
2. Telegram shows `[thread:capture/<id>] <content>` in the Shelly chat.
3. Shelly's reply (either from Franck-triggered dispatch or her own triage logic) appears back in the dashboard thread.

If any of these fail, the problem is most likely one of: `SHELLY_TELEGRAM_WEBHOOK` / `TELEGRAM_BOT_TOKEN` missing in the services `.env`, Shelly's session not restarted (she re-reads SOUL on start), or the subject not being created when the thread endpoint is hit (the migration path plus createCapture both create it — one of them should have).

---

## Self-Review Checklist

**Spec coverage:**
- Problem: "dashboard replies don't push to Telegram" — resolved by Task 7 switching the URL.
- Data model: "no schema change, migrate messages, drop old table" — Task 2.
- Server endpoints remove/rewrite: Tasks 4 + 5.
- Dashboard: Task 7.
- SOUL: Task 8.
- Signals: Task 6.
- Non-goals (promotion re-pointing, signals feed integration, Telegram-born captures): explicitly not touched. Verified.

**Placeholder scan:** no TBD / TODO / "add appropriate" / vague steps. Every code-changing step has the code.

**Type consistency:**
- `getCapture()` returns `{...capture, messages: [{id, role, content, metadata: null, created_at}]}` in Task 4; the same shape is what `captures-view.jsx` reads (it uses `message.role`, `message.content`, `message.created_at` — `metadata` preserved as null to avoid breaking).
- `createCapture({project_id, content, kind?, created_by?})` — same signature as before Task 4.
- `deleteCapture(id)` — same signature.
- `listCaptures({project_id, status?, limit?})` — unchanged.
- Thread module imports: `getOrCreateThread`, `appendMessage`, `listMessages` — all three exist in `src/server/threads.js`.

Plan is consistent. Ready to execute.
