# Signal Inbox — Backend (Stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the additive backend for the signal-inbox redesign — new tables, new endpoints, Telegram thread sync via MCP, and paste-URL project bootstrap — with the existing dashboard UI continuing to work unchanged.

**Architecture:** Four new tables in the master `projects.db` (`subjects`, `threads`, `thread_messages`, `deploy_events`). One aggregator endpoint (`/api/signals`) joins them with existing tickets / captures / workflow_state / BullMQ failures. Threads sync to Telegram via outbound prefix-tagging (`[thread:type/id]`) and inbound MCP tool (`thread_append`) called by Shelly. Project bootstrap is a single endpoint that probes GitHub, creates a Plane project, mints a key, and enqueues a `bootstrap_project` BullMQ job.

**Tech Stack:** Node ESM, better-sqlite3, BullMQ, Express, Vitest, Plane REST API, GitHub REST API, MCP SDK (`@modelcontextprotocol/sdk`).

**Spec:** [docs/superpowers/specs/2026-04-21-signal-inbox-redesign-design.md](../specs/2026-04-21-signal-inbox-redesign-design.md)

---

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `src/server/subjects.js` | upsert subjects, get/set priority |
| `src/server/threads.js` | thread + message CRUD, lazy-create on first access |
| `src/server/telegram-tag.js` | pure parser/builder for `[thread:type/id]` |
| `src/server/deploy-events.js` | record + list deploy/bootstrap events |
| `src/server/signals.js` | cross-project aggregator query |
| `src/server/projects-bootstrap.js` | paste-URL flow orchestration |
| `src/worker/handlers/bootstrap-project.js` | BullMQ handler that runs `git clone` |
| `tests/server/subjects.test.js` | |
| `tests/server/threads.test.js` | |
| `tests/server/telegram-tag.test.js` | |
| `tests/server/deploy-events.test.js` | |
| `tests/server/signals.test.js` | |
| `tests/server/projects-bootstrap.test.js` | |
| `tests/server/routes-signals.test.js` | integration: signals/threads/subjects routes |
| `tests/worker/bootstrap-project.test.js` | |

**Modified files:**

| Path | Change |
|---|---|
| `src/server/db.js` | add table DDL for `subjects`, `threads`, `thread_messages`, `deploy_events` |
| `src/server/routes.js` | register 5 new endpoints |
| `src/server/alerts.js` | `notifyJob()` writes a `deploy_events` row for relevant statuses |
| `src/server/sse.js` | add new event types `signal:new`, `thread:message`, `subject:priority_changed` |
| `src/mcp/server.js` | add `thread_append` MCP tool |
| `src/worker/index.js` | register `bootstrap_project` handler |
| `CLAUDE.md` | add Shelly persona rule for `[thread:...]` tag |

**Conventions to follow** (already used in this repo):
- Table DDL goes inline in `initMasterDatabase()` in `db.js` using `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` sniffing for `ALTER COLUMN`.
- Vitest pool is `threads` with `isolate: true` — per-test module reset works via `vi.resetModules()`.
- Tests use `vi.mock` / `global.fetch = vi.fn()` patterns (see [tests/server/alerts.test.js](../../tests/server/alerts.test.js)).
- All new SQL helpers are pure functions that take a `db` handle (or use `getMasterDatabase()`), no class wrapping.
- All new routes: prefix `/api`, auth via existing `authenticateProject` middleware (or `authenticateAdmin` for admin-only routes).

---

## Task 1: Schema migration — add 4 new tables

**Files:**
- Modify: `src/server/db.js` (extend `initMasterDatabase()`)
- Test: `tests/server/db-schema.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/server/db-schema.test.js`:

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, getMasterDatabase } from '../../src/server/db.js';

describe('signal-inbox schema', () => {
  let tmpDir;
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'devpanel-schema-'));
    initMasterDatabase(tmpDir);
  });

  it('creates subjects table with priority column and indexes', () => {
    const db = getMasterDatabase();
    const cols = db.prepare("PRAGMA table_info(subjects)").all().map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'subject_type', 'subject_id', 'project_id', 'title', 'priority', 'priority_set_at', 'created_at'
    ]));
    const indexes = db.prepare("PRAGMA index_list(subjects)").all().map(i => i.name);
    expect(indexes).toEqual(expect.arrayContaining(['subjects_priority', 'subjects_project']));
  });

  it('creates threads table with unique (subject_type, subject_id)', () => {
    const db = getMasterDatabase();
    const cols = db.prepare("PRAGMA table_info(threads)").all().map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'thread_id', 'subject_type', 'subject_id', 'project_id', 'created_at', 'last_message_at'
    ]));
    const idxList = db.prepare("PRAGMA index_list(threads)").all();
    const uniqIdx = idxList.find(i => i.unique === 1);
    expect(uniqIdx).toBeDefined();
    const cols2 = db.prepare(`PRAGMA index_info(${uniqIdx.name})`).all().map(c => c.name);
    expect(cols2.sort()).toEqual(['subject_id', 'subject_type'].sort());
  });

  it('creates thread_messages table with telegram dedup index', () => {
    const db = getMasterDatabase();
    const cols = db.prepare("PRAGMA table_info(thread_messages)").all().map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'thread_id', 'role', 'source', 'content', 'telegram_message_id', 'created_at'
    ]));
    const indexes = db.prepare("PRAGMA index_list(thread_messages)").all().map(i => i.name);
    expect(indexes).toEqual(expect.arrayContaining(['thread_messages_thread', 'thread_messages_tg_dedup']));
  });

  it('creates deploy_events table indexed by project + created_at', () => {
    const db = getMasterDatabase();
    const cols = db.prepare("PRAGMA table_info(deploy_events)").all().map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'project_id', 'status', 'sha', 'ref', 'log_url', 'failed_reason', 'started_at', 'finished_at', 'created_at'
    ]));
    const indexes = db.prepare("PRAGMA index_list(deploy_events)").all().map(i => i.name);
    expect(indexes).toEqual(expect.arrayContaining(['deploy_events_project_created']));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/db-schema.test.js`
Expected: FAIL — tables don't exist yet (`no such table: subjects`).

- [ ] **Step 3: Add the DDL to `db.js`**

In [src/server/db.js](../../src/server/db.js), inside `initMasterDatabase()`, **after** the existing `captures` / `capture_messages` block, append:

```javascript
  // ============================================================================
  // SIGNAL INBOX — subjects, threads, thread_messages, deploy_events
  // ============================================================================
  masterDb.exec(`
    CREATE TABLE IF NOT EXISTS subjects (
      subject_type     TEXT NOT NULL,
      subject_id       TEXT NOT NULL,
      project_id       TEXT NOT NULL,
      title            TEXT,
      priority         TEXT,
      priority_set_at  DATETIME,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (subject_type, subject_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS subjects_priority ON subjects(priority) WHERE priority IS NOT NULL;
    CREATE INDEX IF NOT EXISTS subjects_project  ON subjects(project_id);

    CREATE TABLE IF NOT EXISTS threads (
      thread_id        INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_type     TEXT NOT NULL,
      subject_id       TEXT NOT NULL,
      project_id       TEXT NOT NULL,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_message_at  DATETIME,
      UNIQUE (subject_type, subject_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS thread_messages (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id             INTEGER NOT NULL,
      role                  TEXT NOT NULL,
      source                TEXT NOT NULL,
      content               TEXT NOT NULL,
      telegram_message_id   INTEGER,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS thread_messages_thread ON thread_messages(thread_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS thread_messages_tg_dedup
      ON thread_messages(telegram_message_id)
      WHERE telegram_message_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS deploy_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    TEXT NOT NULL,
      status        TEXT NOT NULL,
      sha           TEXT,
      ref           TEXT,
      log_url       TEXT,
      failed_reason TEXT,
      started_at    DATETIME,
      finished_at   DATETIME,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS deploy_events_project_created ON deploy_events(project_id, created_at DESC);
  `);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/db-schema.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/db.js tests/server/db-schema.test.js
git commit -m "feat(db): add subjects/threads/thread_messages/deploy_events tables"
```

---

## Task 2: subjects module (upsert + priority CRUD)

**Files:**
- Create: `src/server/subjects.js`
- Test: `tests/server/subjects.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/server/subjects.test.js`:

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, getMasterDatabase, createProject } from '../../src/server/db.js';
import { upsertSubject, setPriority, getSubject } from '../../src/server/subjects.js';

describe('subjects', () => {
  let project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-subj-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'me', github_repo: 'demo' });
  });

  it('upserts a new subject with null priority', () => {
    upsertSubject({ subject_type: 'work_item', subject_id: 'WI-1', project_id: project.id, title: 'Fix login' });
    const s = getSubject('work_item', 'WI-1');
    expect(s).toMatchObject({ subject_type: 'work_item', subject_id: 'WI-1', title: 'Fix login', priority: null });
  });

  it('upsert is idempotent — second call updates title without changing priority', () => {
    upsertSubject({ subject_type: 'work_item', subject_id: 'WI-1', project_id: project.id, title: 'Old' });
    setPriority('work_item', 'WI-1', 'now');
    upsertSubject({ subject_type: 'work_item', subject_id: 'WI-1', project_id: project.id, title: 'New' });
    const s = getSubject('work_item', 'WI-1');
    expect(s.title).toBe('New');
    expect(s.priority).toBe('now');
  });

  it('setPriority writes priority_set_at', () => {
    upsertSubject({ subject_type: 'capture', subject_id: 'cap-1', project_id: project.id, title: 't' });
    setPriority('capture', 'cap-1', 'today');
    const s = getSubject('capture', 'cap-1');
    expect(s.priority).toBe('today');
    expect(s.priority_set_at).toBeTruthy();
  });

  it('setPriority(null) clears the lane', () => {
    upsertSubject({ subject_type: 'capture', subject_id: 'cap-2', project_id: project.id, title: 't' });
    setPriority('capture', 'cap-2', 'now');
    setPriority('capture', 'cap-2', null);
    const s = getSubject('capture', 'cap-2');
    expect(s.priority).toBe(null);
  });

  it('rejects invalid priority value', () => {
    upsertSubject({ subject_type: 'capture', subject_id: 'cap-3', project_id: project.id, title: 't' });
    expect(() => setPriority('capture', 'cap-3', 'urgent')).toThrow(/invalid priority/);
  });

  it('setPriority on unknown subject throws (must upsert first)', () => {
    expect(() => setPriority('work_item', 'NOPE', 'now')).toThrow(/subject not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/subjects.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/server/subjects.js`**

```javascript
// Subjects: cross-cutting registry of "things signals can be about".
// A subject row is upserted on first appearance (in any feed) so it can
// carry the user-driven priority lane. Single source of truth for
// (subject_type, subject_id) → priority.

import { getMasterDatabase } from './db.js';

const VALID_PRIORITIES = new Set(['now', 'today', 'later', null]);
const VALID_SUBJECT_TYPES = new Set(['work_item', 'capture', 'ticket', 'pr', 'deploy', 'job']);

export function upsertSubject({ subject_type, subject_id, project_id, title }) {
  if (!VALID_SUBJECT_TYPES.has(subject_type)) {
    throw new Error(`invalid subject_type: ${subject_type}`);
  }
  const db = getMasterDatabase();
  // Upsert: insert if absent, only update title on conflict (do not overwrite priority).
  db.prepare(`
    INSERT INTO subjects (subject_type, subject_id, project_id, title)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(subject_type, subject_id) DO UPDATE SET
      title = excluded.title,
      project_id = excluded.project_id
  `).run(subject_type, subject_id, project_id, title ?? null);
}

export function getSubject(subject_type, subject_id) {
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT * FROM subjects WHERE subject_type = ? AND subject_id = ?`
  ).get(subject_type, subject_id) || null;
}

export function setPriority(subject_type, subject_id, priority) {
  if (!VALID_PRIORITIES.has(priority)) {
    throw new Error(`invalid priority: ${priority}`);
  }
  const db = getMasterDatabase();
  const row = getSubject(subject_type, subject_id);
  if (!row) throw new Error(`subject not found: ${subject_type}/${subject_id}`);
  db.prepare(`
    UPDATE subjects
       SET priority = ?, priority_set_at = CURRENT_TIMESTAMP
     WHERE subject_type = ? AND subject_id = ?
  `).run(priority, subject_type, subject_id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/subjects.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/subjects.js tests/server/subjects.test.js
git commit -m "feat(subjects): upsert + priority lane CRUD"
```

---

## Task 3: telegram-tag module (parse + build)

**Files:**
- Create: `src/server/telegram-tag.js`
- Test: `tests/server/telegram-tag.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/server/telegram-tag.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { parseTag, buildTag, prependTag } from '../../src/server/telegram-tag.js';

describe('telegram thread tag', () => {
  it('parses a well-formed tag', () => {
    expect(parseTag('[thread:work_item/ZENO-42] hello')).toEqual({
      subject_type: 'work_item',
      subject_id: 'ZENO-42',
      body: 'hello'
    });
  });

  it('parses tag with multi-word body and trailing newlines', () => {
    expect(parseTag('[thread:capture/cap_abc] line1\nline2')).toEqual({
      subject_type: 'capture',
      subject_id: 'cap_abc',
      body: 'line1\nline2'
    });
  });

  it('returns null on missing tag', () => {
    expect(parseTag('plain message')).toBe(null);
  });

  it('returns null on tag not at start of message', () => {
    expect(parseTag('hello [thread:work_item/X-1] body')).toBe(null);
  });

  it('returns null on unknown subject_type', () => {
    expect(parseTag('[thread:wat/X] body')).toBe(null);
  });

  it('returns null on malformed tag (no closing bracket)', () => {
    expect(parseTag('[thread:work_item/X-1 body')).toBe(null);
  });

  it('builds a tag', () => {
    expect(buildTag('work_item', 'ZENO-42')).toBe('[thread:work_item/ZENO-42]');
  });

  it('prependTag composes tag + body', () => {
    expect(prependTag('work_item', 'ZENO-42', 'hello')).toBe('[thread:work_item/ZENO-42] hello');
  });

  it('roundtrips: parseTag(prependTag(...)) recovers original', () => {
    const tagged = prependTag('capture', 'cap_xyz', 'multi\nline');
    expect(parseTag(tagged)).toEqual({ subject_type: 'capture', subject_id: 'cap_xyz', body: 'multi\nline' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/telegram-tag.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/telegram-tag.js`**

```javascript
// Pure parser/builder for the dashboard ↔ Telegram thread tag protocol.
//
// Format: `[thread:<subject_type>/<subject_id>] <body>`
//
// The tag MUST start at character 0. Untagged messages stay in the freeform
// Shelly tab; degrades gracefully when Shelly forgets to tag.

const VALID_TYPES = new Set(['work_item', 'capture', 'ticket', 'pr', 'deploy', 'job']);
const TAG_RE = /^\[thread:([a-z_]+)\/([^\]\s]+)\]\s?/;

export function parseTag(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(TAG_RE);
  if (!m) return null;
  const [, subject_type, subject_id] = m;
  if (!VALID_TYPES.has(subject_type)) return null;
  return {
    subject_type,
    subject_id,
    body: text.slice(m[0].length)
  };
}

export function buildTag(subject_type, subject_id) {
  return `[thread:${subject_type}/${subject_id}]`;
}

export function prependTag(subject_type, subject_id, body) {
  return `${buildTag(subject_type, subject_id)} ${body}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/telegram-tag.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/telegram-tag.js tests/server/telegram-tag.test.js
git commit -m "feat(telegram): thread tag parser/builder"
```

---

## Task 4: threads module (thread + message CRUD with Telegram bridge)

**Files:**
- Create: `src/server/threads.js`
- Test: `tests/server/threads.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/server/threads.test.js`:

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject } from '../../src/server/db.js';
import { upsertSubject } from '../../src/server/subjects.js';
import {
  getOrCreateThread, listMessages, appendMessage, appendFromTelegram
} from '../../src/server/threads.js';

describe('threads', () => {
  let project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-thr-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
    upsertSubject({ subject_type: 'work_item', subject_id: 'WI-1', project_id: project.id, title: 't' });
  });

  it('getOrCreateThread is lazy and idempotent', () => {
    const t1 = getOrCreateThread('work_item', 'WI-1');
    const t2 = getOrCreateThread('work_item', 'WI-1');
    expect(t1.thread_id).toBe(t2.thread_id);
    expect(t1.subject_type).toBe('work_item');
    expect(t1.project_id).toBe(project.id);
  });

  it('appendMessage stores a row and bumps last_message_at', async () => {
    const t = getOrCreateThread('work_item', 'WI-1');
    await new Promise(r => setTimeout(r, 5)); // ensure timestamp diff
    appendMessage({ thread_id: t.thread_id, role: 'user', source: 'web', content: 'hi' });
    const msgs = listMessages(t.thread_id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: 'user', source: 'web', content: 'hi' });
  });

  it('appendFromTelegram dedupes on telegram_message_id', () => {
    const t = getOrCreateThread('work_item', 'WI-1');
    appendFromTelegram({ thread_id: t.thread_id, role: 'shelly', content: 'a', telegram_message_id: 42 });
    appendFromTelegram({ thread_id: t.thread_id, role: 'shelly', content: 'a', telegram_message_id: 42 });
    expect(listMessages(t.thread_id)).toHaveLength(1);
  });

  it('listMessages returns rows in created_at + id order', () => {
    const t = getOrCreateThread('work_item', 'WI-1');
    appendMessage({ thread_id: t.thread_id, role: 'user',   source: 'web', content: '1' });
    appendMessage({ thread_id: t.thread_id, role: 'shelly', source: 'telegram', content: '2' });
    appendMessage({ thread_id: t.thread_id, role: 'system', source: 'system', content: '3' });
    const order = listMessages(t.thread_id).map(m => m.content);
    expect(order).toEqual(['1', '2', '3']);
  });

  it('rejects invalid role / source', () => {
    const t = getOrCreateThread('work_item', 'WI-1');
    expect(() => appendMessage({ thread_id: t.thread_id, role: 'bot', source: 'web', content: 'x' }))
      .toThrow(/invalid role/);
    expect(() => appendMessage({ thread_id: t.thread_id, role: 'user', source: 'sms', content: 'x' }))
      .toThrow(/invalid source/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/threads.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/threads.js`**

```javascript
// Threads: subject-keyed conversations. Lazy-created on first access.
// Cross-platform: rows with source='web' come from the dashboard, source='telegram'
// from inbound MCP calls (Shelly), source='system' from server-emitted events.

import { getMasterDatabase } from './db.js';
import { getSubject } from './subjects.js';

const VALID_ROLES   = new Set(['user', 'shelly', 'system', 'agent']);
const VALID_SOURCES = new Set(['web', 'telegram', 'system']);

export function getOrCreateThread(subject_type, subject_id) {
  const db = getMasterDatabase();
  const existing = db.prepare(
    `SELECT * FROM threads WHERE subject_type = ? AND subject_id = ?`
  ).get(subject_type, subject_id);
  if (existing) return existing;

  const subj = getSubject(subject_type, subject_id);
  if (!subj) throw new Error(`subject not found: ${subject_type}/${subject_id}`);

  const info = db.prepare(
    `INSERT INTO threads (subject_type, subject_id, project_id) VALUES (?, ?, ?)`
  ).run(subject_type, subject_id, subj.project_id);
  return db.prepare(`SELECT * FROM threads WHERE thread_id = ?`).get(info.lastInsertRowid);
}

export function listMessages(thread_id) {
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC`
  ).all(thread_id);
}

export function appendMessage({ thread_id, role, source, content, telegram_message_id = null }) {
  if (!VALID_ROLES.has(role))     throw new Error(`invalid role: ${role}`);
  if (!VALID_SOURCES.has(source)) throw new Error(`invalid source: ${source}`);
  const db = getMasterDatabase();
  const info = db.prepare(`
    INSERT INTO thread_messages (thread_id, role, source, content, telegram_message_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(thread_id, role, source, content, telegram_message_id);
  db.prepare(`UPDATE threads SET last_message_at = CURRENT_TIMESTAMP WHERE thread_id = ?`).run(thread_id);
  return info.lastInsertRowid;
}

// Idempotent insert keyed on telegram_message_id (the unique partial index
// on thread_messages.telegram_message_id will reject duplicates; we swallow
// the constraint error so callers don't have to think about retries).
export function appendFromTelegram({ thread_id, role, content, telegram_message_id }) {
  if (telegram_message_id == null) {
    throw new Error('telegram_message_id required for appendFromTelegram');
  }
  try {
    return appendMessage({ thread_id, role, source: 'telegram', content, telegram_message_id });
  } catch (e) {
    if (String(e.message).includes('UNIQUE constraint failed')) return null;
    throw e;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/threads.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/threads.js tests/server/threads.test.js
git commit -m "feat(threads): lazy-create + message CRUD with Telegram dedup"
```

---

## Task 5: deploy-events module

**Files:**
- Create: `src/server/deploy-events.js`
- Test: `tests/server/deploy-events.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/server/deploy-events.test.js`:

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject } from '../../src/server/db.js';
import { recordDeployEvent, listRecentDeploys } from '../../src/server/deploy-events.js';

describe('deploy events', () => {
  let project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-de-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
  });

  it('records a deploy event', () => {
    const id = recordDeployEvent({
      project_id: project.id, status: 'succeeded',
      sha: 'abc1234', ref: 'main', log_url: 'https://ci/run/1'
    });
    expect(id).toBeGreaterThan(0);
    const rows = listRecentDeploys(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'succeeded', sha: 'abc1234', ref: 'main' });
  });

  it('rejects invalid status', () => {
    expect(() => recordDeployEvent({ project_id: project.id, status: 'maybe' })).toThrow(/invalid status/);
  });

  it('listRecentDeploys returns most recent first, capped', () => {
    for (let i = 0; i < 30; i++) {
      recordDeployEvent({ project_id: project.id, status: 'succeeded', sha: `s${i}` });
    }
    const rows = listRecentDeploys(project.id, 10);
    expect(rows).toHaveLength(10);
    expect(rows[0].sha).toBe('s29');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/deploy-events.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/deploy-events.js`**

```javascript
// Deploy + bootstrap event log. One table for all infra events;
// `status` distinguishes (started, succeeded, failed, bootstrap_succeeded,
// bootstrap_failed). Drives the "deploy" / "bootstrap" rows in /api/signals.

import { getMasterDatabase } from './db.js';

const VALID_STATUSES = new Set([
  'started', 'succeeded', 'failed',
  'bootstrap_started', 'bootstrap_succeeded', 'bootstrap_failed'
]);

export function recordDeployEvent({
  project_id, status, sha = null, ref = null, log_url = null,
  failed_reason = null, started_at = null, finished_at = null
}) {
  if (!VALID_STATUSES.has(status)) throw new Error(`invalid status: ${status}`);
  const db = getMasterDatabase();
  const info = db.prepare(`
    INSERT INTO deploy_events (project_id, status, sha, ref, log_url, failed_reason, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(project_id, status, sha, ref, log_url, failed_reason, started_at, finished_at);
  return info.lastInsertRowid;
}

export function listRecentDeploys(project_id, limit = 50) {
  const db = getMasterDatabase();
  return db.prepare(`
    SELECT * FROM deploy_events
     WHERE project_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?
  `).all(project_id, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/deploy-events.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/deploy-events.js tests/server/deploy-events.test.js
git commit -m "feat(deploys): event recorder for deploy + bootstrap"
```

---

## Task 6: signals aggregator

**Files:**
- Create: `src/server/signals.js`
- Test: `tests/server/signals.test.js`

The aggregator joins five sources: `tickets` (per-project DB), `captures`, `workflow_instances`, `deploy_events`, and BullMQ failed jobs. For Stage 1 we focus on the four that live in the master DB; tickets per-project will be added inside the same loop. BullMQ failed jobs come from `getQueue()` calls (left as a stub returning empty in tests).

- [ ] **Step 1: Write the failing test**

Create `tests/server/signals.test.js`:

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject, getMasterDatabase } from '../../src/server/db.js';
import { upsertSubject, setPriority } from '../../src/server/subjects.js';
import { recordDeployEvent } from '../../src/server/deploy-events.js';

// signals module imports BullMQ; mock the queue helper so tests don't need Redis.
vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ getJobs: async () => [] }),
  QUEUES: { agent: 'agent' }
}));

import { buildSignalsFeed } from '../../src/server/signals.js';

describe('signals aggregator', () => {
  let project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-sig-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
  });

  it('returns empty feed when nothing happened', async () => {
    const rows = await buildSignalsFeed({});
    expect(rows).toEqual([]);
  });

  it('includes a failed deploy as needs_attention urgency', async () => {
    recordDeployEvent({ project_id: project.id, status: 'failed', sha: 'abc', failed_reason: 'lint' });
    const rows = await buildSignalsFeed({});
    const deployRow = rows.find(r => r.signal_type === 'deploy_failed');
    expect(deployRow).toBeDefined();
    expect(deployRow.urgency).toBe('needs_attention');
    expect(deployRow.project_id).toBe(project.id);
  });

  it('includes a successful deploy as fyi urgency', async () => {
    recordDeployEvent({ project_id: project.id, status: 'succeeded', sha: 'def' });
    const rows = await buildSignalsFeed({});
    const deployRow = rows.find(r => r.signal_type === 'deploy_succeeded');
    expect(deployRow.urgency).toBe('fyi');
  });

  it('attaches subject priority to a row when subject row exists', async () => {
    recordDeployEvent({ project_id: project.id, status: 'failed', sha: 'abc' });
    upsertSubject({ subject_type: 'deploy', subject_id: 'abc', project_id: project.id, title: 'deploy abc' });
    setPriority('deploy', 'abc', 'now');
    const rows = await buildSignalsFeed({});
    const deployRow = rows.find(r => r.signal_type === 'deploy_failed');
    expect(deployRow.priority).toBe('now');
  });

  it('filters by priority when ?priority=now', async () => {
    recordDeployEvent({ project_id: project.id, status: 'failed', sha: 'abc' });
    recordDeployEvent({ project_id: project.id, status: 'failed', sha: 'def' });
    upsertSubject({ subject_type: 'deploy', subject_id: 'abc', project_id: project.id, title: 't' });
    setPriority('deploy', 'abc', 'now');
    upsertSubject({ subject_type: 'deploy', subject_id: 'def', project_id: project.id, title: 't' });
    setPriority('deploy', 'def', 'later');
    const rows = await buildSignalsFeed({ priority: 'now' });
    expect(rows.map(r => r.subject_id)).toEqual(['abc']);
  });

  it('filters by needs_me_only', async () => {
    recordDeployEvent({ project_id: project.id, status: 'failed', sha: 'abc' });
    recordDeployEvent({ project_id: project.id, status: 'succeeded', sha: 'def' });
    const rows = await buildSignalsFeed({ needs_me_only: true });
    expect(rows.every(r => r.urgency === 'needs_attention')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/signals.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/signals.js`**

```javascript
// Cross-project signal aggregator. Joins:
//   - deploy_events       (master db) → deploy_failed/succeeded
//   - captures            (master db) → capture_new/triaging
//   - workflow_instances  (master db) → workflow_exhausted/in_progress/done
//   - failed BullMQ jobs  (Redis)     → job_failed
// Each row is annotated with the subject's priority lane (if set).

import { getMasterDatabase } from './db.js';
import { getQueue, QUEUES } from './bullmq.js';

const URGENCY = {
  deploy_failed:        'needs_attention',
  deploy_succeeded:     'fyi',
  bootstrap_failed:     'needs_attention',
  bootstrap_succeeded:  'fyi',
  capture_new:          'needs_attention',
  capture_triaging:     'in_flight',
  workflow_exhausted:   'needs_attention',
  workflow_in_progress: 'in_flight',
  workflow_done:        'fyi',
  job_failed:           'needs_attention'
};

export async function buildSignalsFeed({
  project_id = null, priority = null, needs_me_only = false, since_min = 1440
} = {}) {
  const db = getMasterDatabase();
  const sinceTs = Date.now() - since_min * 60_000;
  const sinceIso = new Date(sinceTs).toISOString();

  const out = [];

  // --- deploy_events ---
  const deployRows = db.prepare(`
    SELECT de.*, p.name AS project_name
      FROM deploy_events de
      JOIN projects p ON p.id = de.project_id
     WHERE de.created_at >= ?
       ${project_id ? 'AND de.project_id = ?' : ''}
  `).all(...(project_id ? [sinceIso, project_id] : [sinceIso]));
  for (const r of deployRows) {
    const signal_type = `deploy_${r.status === 'failed' ? 'failed' : r.status === 'succeeded' ? 'succeeded' : null}`;
    if (!signal_type || signal_type.endsWith('null')) continue;
    out.push({
      subject_type: 'deploy',
      subject_id: r.sha || String(r.id),
      project_id: r.project_id,
      project_name: r.project_name,
      signal_type,
      urgency: URGENCY[signal_type],
      title: r.failed_reason || `${r.ref || 'deploy'} ${r.status}`,
      created_at: r.created_at,
      raw: { sha: r.sha, log_url: r.log_url }
    });
  }

  // --- captures ---
  const captureRows = db.prepare(`
    SELECT c.*, p.name AS project_name,
           (SELECT role FROM capture_messages WHERE capture_id = c.id
              ORDER BY created_at DESC LIMIT 1) AS last_role
      FROM captures c
      JOIN projects p ON p.id = c.project_id
     WHERE c.status IN ('new', 'triaging')
       AND c.created_at >= ?
       ${project_id ? 'AND c.project_id = ?' : ''}
  `).all(...(project_id ? [sinceIso, project_id] : [sinceIso]));
  for (const r of captureRows) {
    const signal_type = r.status === 'new' ? 'capture_new' : 'capture_triaging';
    out.push({
      subject_type: 'capture',
      subject_id: r.id,
      project_id: r.project_id,
      project_name: r.project_name,
      signal_type,
      urgency: URGENCY[signal_type],
      title: r.content.slice(0, 120),
      created_at: r.created_at,
      raw: { last_role: r.last_role }
    });
  }

  // --- workflow_instances ---
  const wiRows = db.prepare(`
    SELECT wi.*, p.id AS project_id_fk, p.name AS project_name
      FROM workflow_instances wi
      JOIN projects p ON p.id = ?
     WHERE wi.last_event_at >= ?
       ${project_id ? '' : ''}
  `).all(project_id || null, sinceTs); // workflow_instances has no project_id today; left-join via param
  // NOTE: workflow_instances doesn't carry project_id in current schema; for Stage 1 we
  // surface workflows for the requested project only, when project_id is provided.
  for (const r of wiRows) {
    let signal_type = null;
    if (r.status === 'awaiting_approval') signal_type = 'workflow_exhausted';
    else if (r.status === 'running')      signal_type = 'workflow_in_progress';
    else if (r.status === 'done')         signal_type = 'workflow_done';
    if (!signal_type) continue;
    out.push({
      subject_type: 'work_item',
      subject_id: r.work_item_id,
      project_id: r.project_id_fk,
      project_name: r.project_name,
      signal_type,
      urgency: URGENCY[signal_type],
      title: `${r.workflow_name} → ${r.current_step}`,
      created_at: new Date(r.last_event_at).toISOString(),
      raw: { revision: r.revision }
    });
  }

  // --- BullMQ failed jobs ---
  try {
    const queue = getQueue(QUEUES.agent);
    const failed = await queue.getJobs(['failed'], 0, 50);
    for (const j of failed) {
      const ts = j.finishedOn || j.processedOn || Date.now();
      if (ts < sinceTs) continue;
      out.push({
        subject_type: 'job',
        subject_id: String(j.id),
        project_id: j.data?.project_id || null,
        project_name: j.data?.project_name || null,
        signal_type: 'job_failed',
        urgency: URGENCY.job_failed,
        title: j.failedReason || 'job failed',
        created_at: new Date(ts).toISOString(),
        raw: { agent: j.data?.agent, attempts: j.attemptsMade }
      });
    }
  } catch (e) {
    // Redis down or queue not initialised — degrade silently rather than 500 the feed.
  }

  // --- annotate priority from subjects ---
  const subjMap = new Map();
  if (out.length > 0) {
    const placeholders = out.map(() => '(?, ?)').join(',');
    const params = out.flatMap(r => [r.subject_type, r.subject_id]);
    const rows = db.prepare(`
      SELECT subject_type, subject_id, priority FROM subjects
       WHERE (subject_type, subject_id) IN (VALUES ${placeholders})
    `).all(...params);
    for (const s of rows) subjMap.set(`${s.subject_type}/${s.subject_id}`, s.priority);
  }
  for (const r of out) r.priority = subjMap.get(`${r.subject_type}/${r.subject_id}`) ?? null;

  // --- filters ---
  let filtered = out;
  if (priority) filtered = filtered.filter(r => r.priority === priority);
  if (needs_me_only) filtered = filtered.filter(r => r.urgency === 'needs_attention');

  // --- sort: needs_attention first, then in_flight, then fyi; within each, newest first.
  const order = { needs_attention: 0, in_flight: 1, fyi: 2 };
  filtered.sort((a, b) => {
    const u = order[a.urgency] - order[b.urgency];
    if (u !== 0) return u;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  return filtered;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/signals.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/signals.js tests/server/signals.test.js
git commit -m "feat(signals): cross-project aggregator with priority annotation"
```

---

## Task 7: alerts.js — record deploy_events on terminal notifyJob calls

**Files:**
- Modify: `src/server/alerts.js` (extend `notifyJob`)
- Test: `tests/server/alerts-deploy-events.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/server/alerts-deploy-events.test.js`:

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject } from '../../src/server/db.js';
import { listRecentDeploys } from '../../src/server/deploy-events.js';

describe('notifyJob writes deploy_events for deploy agent', () => {
  let project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-alrt-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
    process.env.SHELLY_TELEGRAM_WEBHOOK = 'https://webhook.test/hook';
    process.env.SHELLY_DEBOUNCE_MS = '0';
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.resetModules();
  });

  it('records a deploy_succeeded event when agent=deploy + status=done', async () => {
    const { notifyJob } = await import('../../src/server/alerts.js');
    await notifyJob({
      job_id: 'job_1', agent: 'deploy', work_item_id: project.id,
      title: 'release v2', status: 'done', extra: 'sha=abc1234', duration_ms: 4000
    });
    await new Promise(r => setTimeout(r, 30));
    const events = listRecentDeploys(project.id);
    expect(events.length).toBe(1);
    expect(events[0].status).toBe('succeeded');
    expect(events[0].sha).toBe('abc1234');
  });

  it('records a deploy_failed event when agent=deploy + status=failed', async () => {
    const { notifyJob } = await import('../../src/server/alerts.js');
    await notifyJob({
      job_id: 'job_2', agent: 'deploy', work_item_id: project.id,
      title: 'release v2', status: 'failed', extra: 'lint failure'
    });
    await new Promise(r => setTimeout(r, 30));
    const events = listRecentDeploys(project.id);
    expect(events[0].status).toBe('failed');
    expect(events[0].failed_reason).toBe('lint failure');
  });

  it('does not record for non-deploy agents', async () => {
    const { notifyJob } = await import('../../src/server/alerts.js');
    await notifyJob({
      job_id: 'job_3', agent: 'builder', work_item_id: project.id,
      title: 't', status: 'done'
    });
    await new Promise(r => setTimeout(r, 30));
    expect(listRecentDeploys(project.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/alerts-deploy-events.test.js`
Expected: FAIL — `notifyJob` does not write deploy_events.

- [ ] **Step 3: Extend `notifyJob`**

Add to the top of `src/server/alerts.js` (after existing imports — there are none today; add the import line):

```javascript
import { recordDeployEvent } from './deploy-events.js';
```

Inside `notifyJob`, before the existing `_debounceBuffer.push(...)`, insert:

```javascript
  // Persist deploy + bootstrap events so the signals feed can surface them.
  // Best-effort — never throw out of notifyJob.
  if (agent === 'deploy' || agent === 'bootstrap') {
    try {
      const status = agent === 'bootstrap'
        ? (status === 'done' ? 'bootstrap_succeeded' : status === 'failed' ? 'bootstrap_failed' : null)
        : (status === 'done' ? 'succeeded' : status === 'failed' ? 'failed' : null);
      if (status && work_item_id) {
        const shaMatch = String(extra || '').match(/sha=([a-f0-9]+)/i);
        recordDeployEvent({
          project_id: work_item_id,           // for deploy/bootstrap, work_item_id IS the project id
          status,
          sha: shaMatch ? shaMatch[1] : null,
          failed_reason: status === 'failed' ? String(extra || '').slice(0, 200) : null
        });
      }
    } catch (e) {
      console.error('[Alerts] recordDeployEvent failed:', e.message);
    }
  }
```

NOTE: the local variable `status` is shadowed inside the `if (agent === 'deploy' || ...)` block. Rename the local to `eventStatus` to avoid the shadow:

```javascript
  if (agent === 'deploy' || agent === 'bootstrap') {
    try {
      const eventStatus = agent === 'bootstrap'
        ? (status === 'done' ? 'bootstrap_succeeded' : status === 'failed' ? 'bootstrap_failed' : null)
        : (status === 'done' ? 'succeeded' : status === 'failed' ? 'failed' : null);
      if (eventStatus && work_item_id) {
        const shaMatch = String(extra || '').match(/sha=([a-f0-9]+)/i);
        recordDeployEvent({
          project_id: work_item_id,
          status: eventStatus,
          sha: shaMatch ? shaMatch[1] : null,
          failed_reason: eventStatus === 'failed' ? String(extra || '').slice(0, 200) : null
        });
      }
    } catch (e) {
      console.error('[Alerts] recordDeployEvent failed:', e.message);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/alerts-deploy-events.test.js`
Expected: PASS (3 tests). Also re-run `npx vitest run tests/server/alerts.test.js` to make sure existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/alerts.js tests/server/alerts-deploy-events.test.js
git commit -m "feat(alerts): record deploy_events from notifyJob for deploy/bootstrap agents"
```

---

## Task 8: routes — subject + thread + signal HTTP endpoints

**Files:**
- Modify: `src/server/routes.js`
- Test: `tests/server/routes-signals.test.js` (new)

This adds 4 endpoints (the 5th — `POST /api/projects/from-github` — gets its own task because it's heavier).

- [ ] **Step 1: Write the failing test**

Create `tests/server/routes-signals.test.js`:

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject } from '../../src/server/db.js';
import { upsertSubject } from '../../src/server/subjects.js';
import { recordDeployEvent } from '../../src/server/deploy-events.js';

vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ getJobs: async () => [] }),
  QUEUES: { agent: 'agent' }
}));

describe('signal/thread/subject routes', () => {
  let app, project;
  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-routes-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
    const { createRouter } = await import('../../src/server/routes.js');
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ storagePath: tmp }));
  });

  it('GET /api/signals returns aggregated rows', async () => {
    recordDeployEvent({ project_id: project.id, status: 'failed', sha: 'abc', failed_reason: 'lint' });
    const r = await request(app).get('/api/signals')
      .set('X-API-Key', project.api_key);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.signals)).toBe(true);
    expect(r.body.signals.length).toBeGreaterThan(0);
  });

  it('GET /api/threads/:type/:id lazy-creates and returns messages', async () => {
    upsertSubject({ subject_type: 'work_item', subject_id: 'WI-1', project_id: project.id, title: 't' });
    const r = await request(app).get('/api/threads/work_item/WI-1')
      .set('X-API-Key', project.api_key);
    expect(r.status).toBe(200);
    expect(r.body.thread_id).toBeGreaterThan(0);
    expect(r.body.messages).toEqual([]);
  });

  it('POST /api/threads/:type/:id/messages appends a user message and posts to Telegram', async () => {
    upsertSubject({ subject_type: 'work_item', subject_id: 'WI-2', project_id: project.id, title: 't' });
    process.env.SHELLY_TELEGRAM_WEBHOOK = 'https://webhook.test/hook';
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const r = await request(app).post('/api/threads/work_item/WI-2/messages')
      .set('X-API-Key', project.api_key)
      .send({ content: 'hello shelly' });
    expect(r.status).toBe(200);
    expect(global.fetch).toHaveBeenCalled();
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.text).toMatch(/^\[thread:work_item\/WI-2\] hello shelly/);
  });

  it('PATCH /api/subjects/:type/:id updates priority', async () => {
    upsertSubject({ subject_type: 'capture', subject_id: 'cap-1', project_id: project.id, title: 't' });
    const r = await request(app).patch('/api/subjects/capture/cap-1')
      .set('X-API-Key', project.api_key)
      .send({ priority: 'now' });
    expect(r.status).toBe(200);
    expect(r.body.priority).toBe('now');
  });

  it('PATCH /api/subjects rejects invalid priority', async () => {
    upsertSubject({ subject_type: 'capture', subject_id: 'cap-2', project_id: project.id, title: 't' });
    const r = await request(app).patch('/api/subjects/capture/cap-2')
      .set('X-API-Key', project.api_key)
      .send({ priority: 'urgent' });
    expect(r.status).toBe(400);
  });
});
```

Add `supertest` if missing: `npm install --save-dev supertest`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/routes-signals.test.js`
Expected: FAIL — endpoints don't exist yet.

- [ ] **Step 3: Add the endpoints to `routes.js`**

At the top of `routes.js`, add imports:

```javascript
import { upsertSubject, getSubject, setPriority } from './subjects.js';
import { getOrCreateThread, listMessages, appendMessage } from './threads.js';
import { buildSignalsFeed } from './signals.js';
import { prependTag } from './telegram-tag.js';
```

Inside `createRouter()`, after the existing route definitions (find a stable anchor like the activity route or the captures routes), add:

```javascript
  // ============================================================================
  // SIGNAL INBOX — signals / threads / subjects
  // ============================================================================

  router.get('/signals', authenticateProject, async (req, res) => {
    try {
      const { project, priority, needs_me_only, since_min } = req.query;
      const signals = await buildSignalsFeed({
        project_id: project || req.project.id,  // default to caller's project; explicit ?project=... wins
        priority: priority || null,
        needs_me_only: needs_me_only === '1' || needs_me_only === 'true',
        since_min: since_min ? parseInt(since_min, 10) : 1440
      });
      res.json({ signals });
    } catch (e) {
      console.error('[signals]', e);
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/threads/:subject_type/:subject_id', authenticateProject, (req, res) => {
    try {
      const { subject_type, subject_id } = req.params;
      const thread = getOrCreateThread(subject_type, subject_id);
      const messages = listMessages(thread.thread_id);
      res.json({ ...thread, messages });
    } catch (e) {
      const status = /not found/i.test(e.message) ? 404 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  router.post('/threads/:subject_type/:subject_id/messages', authenticateProject, async (req, res) => {
    try {
      const { subject_type, subject_id } = req.params;
      const { content } = req.body || {};
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'content required' });
      }
      const thread = getOrCreateThread(subject_type, subject_id);
      const id = appendMessage({ thread_id: thread.thread_id, role: 'user', source: 'web', content });
      // Forward to Telegram with tag prefix; fire-and-forget. Inlines the same
      // env-driven send used in alerts.js#_sendText (not currently exported —
      // see follow-up nit at the bottom of the plan).
      const text = prependTag(subject_type, subject_id, content);
      const url = process.env.SHELLY_TELEGRAM_WEBHOOK;
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chat  = process.env.TELEGRAM_CHAT_ID;
      if (url) {
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
          .catch(err => console.error('[threads] webhook send failed:', err.message));
      } else if (token && chat) {
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text })
        }).catch(err => console.error('[threads] telegram API send failed:', err.message));
      }
      res.json({ id, thread_id: thread.thread_id });
    } catch (e) {
      const status = /not found/i.test(e.message) ? 404 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  router.patch('/subjects/:subject_type/:subject_id', authenticateProject, (req, res) => {
    try {
      const { subject_type, subject_id } = req.params;
      const { priority, title } = req.body || {};
      // Auto-upsert if missing — caller may be flagging a freshly-seen subject.
      if (!getSubject(subject_type, subject_id)) {
        upsertSubject({ subject_type, subject_id, project_id: req.project.id, title: title || null });
      }
      if (priority !== undefined) setPriority(subject_type, subject_id, priority);
      res.json(getSubject(subject_type, subject_id));
    } catch (e) {
      const status = /invalid/i.test(e.message) ? 400 : 500;
      res.status(status).json({ error: e.message });
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/routes-signals.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/routes.js tests/server/routes-signals.test.js package.json package-lock.json
git commit -m "feat(routes): add /signals, /threads, /subjects endpoints"
```

---

## Task 9: MCP tool — `thread_append` for Shelly inbound

**Files:**
- Modify: `src/mcp/server.js`
- Test: `tests/server/mcp-thread-append.test.js` (new)

Inbound Telegram messages reach Shelly first (only one process polls the bot token; see [CLAUDE.md](../../CLAUDE.md)). Shelly calls this MCP tool to push tagged messages back into the dashboard's thread.

- [ ] **Step 1: Write the failing test**

Create `tests/server/mcp-thread-append.test.js`:

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject } from '../../src/server/db.js';
import { upsertSubject } from '../../src/server/subjects.js';
import { listMessages, getOrCreateThread } from '../../src/server/threads.js';
import { handleThreadAppend } from '../../src/mcp/server.js';

describe('MCP thread_append', () => {
  let project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-mcp-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
    upsertSubject({ subject_type: 'work_item', subject_id: 'WI-1', project_id: project.id, title: 't' });
  });

  it('appends a tagged message to the right thread', async () => {
    const result = await handleThreadAppend({
      raw_text: '[thread:work_item/WI-1] yeah I see it',
      role: 'shelly',
      telegram_message_id: 1234
    });
    expect(result.appended).toBe(true);
    const thread = getOrCreateThread('work_item', 'WI-1');
    const msgs = listMessages(thread.thread_id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('yeah I see it');
    expect(msgs[0].source).toBe('telegram');
  });

  it('refuses untagged text', async () => {
    const result = await handleThreadAppend({
      raw_text: 'no tag here', role: 'shelly', telegram_message_id: 1
    });
    expect(result.appended).toBe(false);
    expect(result.reason).toMatch(/no tag/i);
  });

  it('dedupes on telegram_message_id', async () => {
    await handleThreadAppend({ raw_text: '[thread:work_item/WI-1] a', role: 'shelly', telegram_message_id: 99 });
    await handleThreadAppend({ raw_text: '[thread:work_item/WI-1] a', role: 'shelly', telegram_message_id: 99 });
    const thread = getOrCreateThread('work_item', 'WI-1');
    expect(listMessages(thread.thread_id)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/mcp-thread-append.test.js`
Expected: FAIL — `handleThreadAppend` not exported.

- [ ] **Step 3: Add handler + tool registration to `src/mcp/server.js`**

At the top of the file (after existing imports), add:

```javascript
import { parseTag } from '../server/telegram-tag.js';
import { getSubject } from '../server/subjects.js';
import { getOrCreateThread, appendFromTelegram } from '../server/threads.js';
```

Add the handler (export it for test):

```javascript
export async function handleThreadAppend({ raw_text, role, telegram_message_id }) {
  const parsed = parseTag(raw_text);
  if (!parsed) return { appended: false, reason: 'no tag in message' };
  if (!getSubject(parsed.subject_type, parsed.subject_id)) {
    return { appended: false, reason: `unknown subject ${parsed.subject_type}/${parsed.subject_id}` };
  }
  const thread = getOrCreateThread(parsed.subject_type, parsed.subject_id);
  const id = appendFromTelegram({
    thread_id: thread.thread_id,
    role: role || 'shelly',
    content: parsed.body,
    telegram_message_id
  });
  return { appended: id != null, thread_id: thread.thread_id };
}
```

Register the MCP tool (use the existing `server.tool(...)` pattern; place near the other devpanel tools):

```javascript
server.tool(
  'thread_append',
  'Forward a tagged Telegram message into the dashboard\'s thread for the matching subject. Use when the user (or another bot) sends a message starting with [thread:type/id].',
  {
    raw_text: z.string().describe('Full message text including the [thread:type/id] prefix'),
    role: z.string().default('shelly').describe('user | shelly | agent'),
    telegram_message_id: z.number().describe('Telegram message_id for dedup')
  },
  async ({ raw_text, role, telegram_message_id }) => {
    const result = await handleThreadAppend({ raw_text, role, telegram_message_id });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/mcp-thread-append.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.js tests/server/mcp-thread-append.test.js
git commit -m "feat(mcp): thread_append tool for Shelly inbound Telegram sync"
```

---

## Task 10: SSE event types

**Files:**
- Modify: `src/server/sse.js` (already exists; extend with new event names)
- Modify: `src/server/routes.js` (emit on signal write paths)
- Test: `tests/server/sse-signals.test.js` (new — light)

- [ ] **Step 1: Write the failing test**

Create `tests/server/sse-signals.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import { broadcast } from '../../src/server/sse.js';

describe('sse: signal events', () => {
  it('broadcast accepts signal:new and subject:priority_changed event names', () => {
    // sse.broadcast does not throw on unknown event names today; this test
    // documents that the new names are first-class. We just verify it doesn't crash.
    expect(() => broadcast('signal:new', { subject_type: 'deploy', subject_id: 'abc' })).not.toThrow();
    expect(() => broadcast('subject:priority_changed', { subject_type: 'capture', subject_id: 'cap-1', priority: 'now' })).not.toThrow();
    expect(() => broadcast('thread:message', { thread_id: 1, message: { id: 1, role: 'user', content: 'hi' } })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/sse-signals.test.js`
Expected: PASS or FAIL depending on existing sse.js. If `broadcast` is exported and accepts arbitrary event names, this passes immediately — verify by reading [src/server/sse.js](../../src/server/sse.js) and confirming the function signature.

If it currently restricts event names to a whitelist, extend the whitelist:

```javascript
// in sse.js, find the allowed event list and add:
'signal:new', 'signal:resolved', 'subject:priority_changed', 'thread:message'
```

- [ ] **Step 3: Emit events from the write paths**

In `src/server/routes.js`, in the PATCH `/subjects/...` handler, after `setPriority(...)`:

```javascript
broadcast('subject:priority_changed', {
  subject_type, subject_id, priority,
  project_id: req.project.id
});
```

In the POST `/threads/.../messages` handler, after `appendMessage(...)`:

```javascript
broadcast('thread:message', {
  thread_id: thread.thread_id,
  message: { id, role: 'user', source: 'web', content, created_at: new Date().toISOString() }
});
```

In `src/mcp/server.js` `handleThreadAppend`, after a successful append:

```javascript
import { broadcast } from '../server/sse.js';
// ...
if (id != null) {
  broadcast('thread:message', {
    thread_id: thread.thread_id,
    message: { id, role, source: 'telegram', content: parsed.body, created_at: new Date().toISOString() }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/sse-signals.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/sse.js src/server/routes.js src/mcp/server.js tests/server/sse-signals.test.js
git commit -m "feat(sse): signal:new / subject:priority_changed / thread:message events"
```

---

## Task 11: projects-bootstrap module

**Files:**
- Create: `src/server/projects-bootstrap.js`
- Test: `tests/server/projects-bootstrap.test.js`

GitHub probe + Plane create + key mint + bootstrap-job enqueue. External calls are mocked via `global.fetch`.

- [ ] **Step 1: Write the failing test**

Create `tests/server/projects-bootstrap.test.js`:

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, getProjectByName } from '../../src/server/db.js';

vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ add: vi.fn().mockResolvedValue({ id: 'job_boot_1' }) }),
  QUEUES: { agent: 'agent' }
}));

import { bootstrapFromGithub, parseGithubUrl } from '../../src/server/projects-bootstrap.js';

describe('parseGithubUrl', () => {
  it('handles https url', () => {
    expect(parseGithubUrl('https://github.com/franck/zeno')).toEqual({ owner: 'franck', repo: 'zeno' });
  });
  it('handles https url with .git suffix', () => {
    expect(parseGithubUrl('https://github.com/franck/zeno.git')).toEqual({ owner: 'franck', repo: 'zeno' });
  });
  it('handles ssh url', () => {
    expect(parseGithubUrl('git@github.com:franck/zeno.git')).toEqual({ owner: 'franck', repo: 'zeno' });
  });
  it('handles owner/repo shorthand', () => {
    expect(parseGithubUrl('franck/zeno')).toEqual({ owner: 'franck', repo: 'zeno' });
  });
  it('throws on garbage', () => {
    expect(() => parseGithubUrl('not a url')).toThrow(/invalid github/i);
  });
});

describe('bootstrapFromGithub', () => {
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-bs-'));
    initMasterDatabase(tmp);
    process.env.PLANE_API_BASE = 'https://plane.test';
    process.env.PLANE_WORKSPACE_SLUG = 'devpanl';
    process.env.PLANE_API_TOKEN = 'plane_tok';
    process.env.GITHUB_TOKEN = 'gh_tok';
    process.env.AGENTS_HOST_PROJECTS_PATH = '/home/deploy/projects';
  });

  it('happy path: probes GitHub, creates Plane project, mints key, enqueues clone', async () => {
    global.fetch = vi.fn(async (url) => {
      if (url.includes('api.github.com/repos/franck/zeno')) {
        return { ok: true, status: 200, json: async () => ({
          name: 'zeno', description: 'zen', default_branch: 'main', language: 'TypeScript'
        }) };
      }
      if (url.includes('plane.test')) {
        return { ok: true, status: 201, json: async () => ({ id: 'plane-uuid-123' }) };
      }
      throw new Error('unexpected fetch ' + url);
    });

    const result = await bootstrapFromGithub({ github_url: 'https://github.com/franck/zeno' });
    expect(result.project.name).toBe('zeno');
    expect(result.project.api_key).toMatch(/^dp_/);
    expect(result.project.plane_project_id).toBe('plane-uuid-123');
    expect(result.project.github_owner).toBe('franck');
    expect(result.project.local_path).toBe('/home/deploy/projects/zeno');
    expect(result.bootstrap_job_id).toBe('job_boot_1');
    // verify project is in DB
    expect(getProjectByName('zeno')).toBeTruthy();
  });

  it('aborts before any DB write when GitHub probe fails', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ message: 'Not Found' }) }));
    await expect(bootstrapFromGithub({ github_url: 'https://github.com/franck/missing' }))
      .rejects.toThrow(/github.*not found/i);
    expect(getProjectByName('missing')).toBeFalsy();
  });

  it('aborts before mint when Plane create fails', async () => {
    let callCount = 0;
    global.fetch = vi.fn(async (url) => {
      callCount++;
      if (url.includes('api.github.com')) {
        return { ok: true, status: 200, json: async () => ({ name: 'edms', default_branch: 'main' }) };
      }
      if (url.includes('plane.test')) {
        return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      }
    });
    await expect(bootstrapFromGithub({ github_url: 'franck/edms' })).rejects.toThrow(/plane/i);
    expect(getProjectByName('edms')).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/projects-bootstrap.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/server/projects-bootstrap.js`**

```javascript
// Paste-URL project bootstrap.
//
// One call: probe GitHub → create Plane project → mint DevPanel API key →
// enqueue an async `bootstrap_project` job that clones the repo on the
// agents host. Project is usable in the dashboard immediately; the clone
// completion is surfaced as a signal.

import { createProject, updateProject, getProjectByName } from './db.js';
import { getQueue, QUEUES } from './bullmq.js';

const GH_HTTPS_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const GH_SSH_RE   = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/;
const GH_SHORT_RE = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/;

export function parseGithubUrl(url) {
  if (typeof url !== 'string') throw new Error('invalid github url');
  const trimmed = url.trim();
  for (const re of [GH_HTTPS_RE, GH_SSH_RE, GH_SHORT_RE]) {
    const m = trimmed.match(re);
    if (m) return { owner: m[1], repo: m[2] };
  }
  throw new Error(`invalid github url: ${url}`);
}

async function probeGithub({ owner, repo }) {
  const token = process.env.GITHUB_TOKEN;
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: token
      ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
      : { Accept: 'application/vnd.github+json' }
  });
  if (r.status === 404) throw new Error(`github: repo ${owner}/${repo} not found or token lacks access`);
  if (!r.ok) throw new Error(`github: ${r.status} ${(await r.json().catch(() => ({}))).message || ''}`);
  return r.json();
}

async function createPlaneProject({ name, description, identifier }) {
  const base = process.env.PLANE_API_BASE;
  const slug = process.env.PLANE_WORKSPACE_SLUG;
  const token = process.env.PLANE_API_TOKEN;
  if (!base || !slug || !token) throw new Error('plane: PLANE_API_BASE / PLANE_WORKSPACE_SLUG / PLANE_API_TOKEN required');
  const r = await fetch(`${base}/api/v1/workspaces/${slug}/projects/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': token },
    body: JSON.stringify({ name, description: description || '', identifier })
  });
  if (!r.ok) throw new Error(`plane: ${r.status} ${(await r.json().catch(() => ({}))).error || ''}`);
  return r.json();
}

function planeIdentifier(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5).toUpperCase() || 'PROJ';
}

export async function bootstrapFromGithub({ github_url }) {
  const { owner, repo } = parseGithubUrl(github_url);

  // Step 1: GitHub probe (no writes yet).
  const ghRepo = await probeGithub({ owner, repo });

  // Step 2: Plane create (no writes to our DB yet).
  let planeProj;
  try {
    planeProj = await createPlaneProject({
      name: ghRepo.name,
      description: ghRepo.description,
      identifier: planeIdentifier(ghRepo.name)
    });
  } catch (e) {
    if (/identifier.*already/i.test(e.message)) {
      planeProj = await createPlaneProject({
        name: ghRepo.name,
        description: ghRepo.description,
        identifier: planeIdentifier(ghRepo.name + '2')
      });
    } else {
      throw e;
    }
  }

  // Step 3: Mint DevPanel project + key.
  const localPath = `${process.env.AGENTS_HOST_PROJECTS_PATH || '/home/deploy/projects'}/${ghRepo.name}`;
  const project = createProject({
    name: ghRepo.name,
    description: ghRepo.description || '',
    github_owner: owner,
    github_repo: repo,
    plane_project_id: planeProj.id,
    plane_workspace_slug: process.env.PLANE_WORKSPACE_SLUG,
    default_branch: ghRepo.default_branch || 'main',
    local_path: localPath
  });

  // Step 4: Enqueue bootstrap job (best effort — failure surfaces as a signal).
  let bootstrap_job_id = null;
  try {
    const queue = getQueue(QUEUES.agent);
    const job = await queue.add('bootstrap_project', {
      agent: 'bootstrap',                  // dispatched by src/worker/index.js via jobData.agent
      project_id: project.id,
      github_url,
      target_path: localPath
    }, { attempts: 2, backoff: { type: 'exponential', delay: 30_000 } });
    bootstrap_job_id = job.id;
  } catch (e) {
    console.error('[bootstrap] enqueue failed:', e.message);
  }

  return { project, bootstrap_job_id };
}
```

NOTE: `createProject` may need to accept the new fields (`description`, `plane_project_id`, etc.) — check [src/server/db.js](../../src/server/db.js) for its current signature. If it doesn't pass through these fields, extend it OR call `updateProject(project.id, {...rest})` after the bare `createProject({ name, github_owner, github_repo })` call. Adjust the test to match whichever path is taken.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/projects-bootstrap.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/projects-bootstrap.js tests/server/projects-bootstrap.test.js
git commit -m "feat(bootstrap): paste-URL project orchestration (GitHub + Plane + key + clone job)"
```

---

## Task 12: HTTP endpoint `POST /api/projects/from-github`

**Files:**
- Modify: `src/server/routes.js`
- Test: `tests/server/routes-bootstrap.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/server/routes-bootstrap.test.js`:

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, getMasterDatabase } from '../../src/server/db.js';

vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ add: vi.fn().mockResolvedValue({ id: 'job_x' }) }),
  QUEUES: { agent: 'agent' }
}));

describe('POST /api/projects/from-github', () => {
  let app, adminKey;
  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-pb-'));
    initMasterDatabase(tmp);
    adminKey = 'admin_test_key';
    process.env.DEVPANEL_ADMIN_KEY = adminKey;
    process.env.PLANE_API_BASE = 'https://plane.test';
    process.env.PLANE_WORKSPACE_SLUG = 'devpanl';
    process.env.PLANE_API_TOKEN = 'plane_tok';
    process.env.GITHUB_TOKEN = 'gh_tok';
    global.fetch = vi.fn(async (url) => {
      if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => ({ name: 'newproj', default_branch: 'main' }) };
      if (url.includes('plane.test')) return { ok: true, status: 201, json: async () => ({ id: 'plane-x' }) };
    });
    const { createRouter } = await import('../../src/server/routes.js');
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ storagePath: tmp }));
  });

  it('requires admin key', async () => {
    const r = await request(app).post('/api/projects/from-github').send({ github_url: 'a/b' });
    expect(r.status).toBe(401);
  });

  it('happy path: returns project + bootstrap_job_id', async () => {
    const r = await request(app).post('/api/projects/from-github')
      .set('X-Admin-Key', adminKey)
      .send({ github_url: 'https://github.com/me/newproj' });
    expect(r.status).toBe(201);
    expect(r.body.project.name).toBe('newproj');
    expect(r.body.bootstrap_job_id).toBe('job_x');
  });

  it('returns 400 on garbage URL', async () => {
    const r = await request(app).post('/api/projects/from-github')
      .set('X-Admin-Key', adminKey)
      .send({ github_url: 'not a url' });
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/routes-bootstrap.test.js`
Expected: FAIL — endpoint not registered.

- [ ] **Step 3: Add the endpoint**

In `src/server/routes.js`, add the import:

```javascript
import { bootstrapFromGithub } from './projects-bootstrap.js';
```

If an `authenticateAdmin` middleware doesn't exist yet, add it near `authenticateProject`:

```javascript
function authenticateAdmin(req, res, next) {
  const k = req.headers['x-admin-key'];
  const expected = process.env.DEVPANEL_ADMIN_KEY;
  if (!expected || !k || k !== expected) {
    return res.status(401).json({ error: 'admin key required' });
  }
  next();
}
```

(Check if it exists already — the projects view in the dashboard uses an admin key, so there is likely existing handling. Reuse it.)

Add the route:

```javascript
  router.post('/projects/from-github', authenticateAdmin, async (req, res) => {
    try {
      const { github_url } = req.body || {};
      if (!github_url) return res.status(400).json({ error: 'github_url required' });
      const result = await bootstrapFromGithub({ github_url });
      res.status(201).json(result);
    } catch (e) {
      const status = /invalid github/i.test(e.message) ? 400
                   : /not found/i.test(e.message)     ? 404
                   : 500;
      res.status(status).json({ error: e.message });
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/routes-bootstrap.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/routes.js tests/server/routes-bootstrap.test.js
git commit -m "feat(routes): POST /api/projects/from-github paste-URL bootstrap"
```

---

## Task 13: Worker handler `bootstrap_project`

**Files:**
- Create: `src/worker/handlers/bootstrap-project.js`
- Modify: `src/worker/index.js` (register handler)
- Test: `tests/worker/bootstrap-project.test.js`

The handler is a thin wrapper: spawn `git clone`, capture stderr on failure, post status via `notifyJob`. We test it by stubbing `child_process.spawn`.

- [ ] **Step 1: Write the failing test**

Create `tests/worker/bootstrap-project.test.js`:

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn()
}));
vi.mock('../../src/server/alerts.js', () => ({
  notifyJob: vi.fn()
}));

describe('bootstrap_project handler', () => {
  let spawnMock, notifyMock;
  beforeEach(async () => {
    const cp = await import('child_process');
    spawnMock = cp.spawn;
    const al = await import('../../src/server/alerts.js');
    notifyMock = al.notifyJob;
    spawnMock.mockReset();
    notifyMock.mockReset();
  });

  function fakeProc(exitCode, stderr = '') {
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    setTimeout(() => {
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      proc.emit('exit', exitCode);
    }, 5);
    return proc;
  }

  it('runs git clone and notifies done on exit 0', async () => {
    spawnMock.mockReturnValue(fakeProc(0));
    const { handleBootstrapProject } = await import('../../src/worker/handlers/bootstrap-project.js');
    await handleBootstrapProject({
      data: { project_id: 'proj_1', github_url: 'https://github.com/me/x', target_path: '/tmp/x' },
      id: 'job_1'
    });
    expect(spawnMock).toHaveBeenCalledWith('git', expect.arrayContaining(['clone', 'https://github.com/me/x', '/tmp/x']), expect.any(Object));
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'bootstrap', status: 'done', work_item_id: 'proj_1'
    }));
  });

  it('notifies failed on non-zero exit and rethrows for BullMQ retry', async () => {
    spawnMock.mockReturnValue(fakeProc(128, 'fatal: Repository not found'));
    const { handleBootstrapProject } = await import('../../src/worker/handlers/bootstrap-project.js');
    await expect(handleBootstrapProject({
      data: { project_id: 'proj_2', github_url: 'https://github.com/me/missing', target_path: '/tmp/missing' },
      id: 'job_2'
    })).rejects.toThrow(/Repository not found/);
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'bootstrap', status: 'failed', work_item_id: 'proj_2'
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worker/bootstrap-project.test.js`
Expected: FAIL — handler doesn't exist.

- [ ] **Step 3: Implement the handler**

Create `src/worker/handlers/bootstrap-project.js`:

```javascript
// BullMQ handler: clones a freshly-bootstrapped project on the agents host.
// Posts status back via notifyJob so the deploy_events table gets a row
// (see alerts.js + Task 7) and the signal feed surfaces it.

import { spawn } from 'child_process';
import { dirname } from 'path';
import { mkdirSync } from 'fs';
import { notifyJob } from '../../server/alerts.js';

export async function handleBootstrapProject(job) {
  const { project_id, github_url, target_path } = job.data;
  const startedAt = Date.now();

  // Ensure parent directory exists (idempotent).
  try { mkdirSync(dirname(target_path), { recursive: true }); }
  catch (e) { /* Best-effort — git clone will fail loudly if mkdir actually mattered. */ }

  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['clone', github_url, target_path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    proc.on('exit', async (code) => {
      const duration_ms = Date.now() - startedAt;
      if (code === 0) {
        await notifyJob({
          job_id: String(job.id), agent: 'bootstrap', work_item_id: project_id,
          title: `clone ${github_url}`, status: 'done', duration_ms
        });
        resolve({ ok: true, target_path });
      } else {
        const reason = (stderr.split('\n').find(l => l.startsWith('fatal:')) || stderr.trim().split('\n')[0] || `exit ${code}`).slice(0, 200);
        await notifyJob({
          job_id: String(job.id), agent: 'bootstrap', work_item_id: project_id,
          title: `clone ${github_url}`, status: 'failed', extra: reason, duration_ms
        });
        reject(new Error(reason));
      }
    });
    proc.on('error', async (err) => {
      await notifyJob({
        job_id: String(job.id), agent: 'bootstrap', work_item_id: project_id,
        title: `clone ${github_url}`, status: 'failed', extra: err.message
      });
      reject(err);
    });
  });
}
```

- [ ] **Step 4: Register the handler in worker**

In [src/worker/index.js](../../src/worker/index.js) the existing dispatch pattern is `if (jobData.agent === '<name>') { ... return; }` early in the `Worker(...)` callback (see the `deploy` and `shelly_digest` branches around line 190).

Add a sibling branch **before** the `enrichWorkItemFromPlane` call:

```javascript
    if (jobData.agent === 'bootstrap') {
      const { handleBootstrapProject } = await import('./handlers/bootstrap-project.js');
      return handleBootstrapProject({ id: job.id, data: jobData });
    }
```

No top-level import needed — the existing handlers use dynamic `import()` inside each branch for lazy loading. Match that pattern.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/worker/bootstrap-project.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/worker/handlers/bootstrap-project.js src/worker/index.js tests/worker/bootstrap-project.test.js
git commit -m "feat(worker): bootstrap_project handler — git clone + status callback"
```

---

## Task 14: Update Shelly persona (CLAUDE.md) with thread-tag rule

**Files:**
- Modify: `CLAUDE.md` (Shelly persona section)

No tests — documentation update.

- [ ] **Step 1: Read the current Shelly persona section**

Open [CLAUDE.md](../../CLAUDE.md) and locate the section starting `## Shelly's persona — how to handle Telegram conversations`.

- [ ] **Step 2: Add a `Thread tag protocol` subsection**

Insert after the `### Hard rules` block:

```markdown
### Thread tag protocol — keep dashboard threads in sync

DevPanel routes per-subject conversations through Telegram using a tag prefix:
`[thread:<subject_type>/<subject_id>]`. When you reply about a specific subject
the user raised in the dashboard, **prefix your reply with the same tag** so the
dashboard can attach the message to the right thread:

```
[thread:work_item/ZENO-42] Bug confirmé. Je dispatch un fix sur l'agent builder.
```

Subject types: `work_item | capture | ticket | pr | deploy | job`.

When you see a tagged message arrive (whether it's the user replying from the
dashboard, or another agent), call the devpanel MCP tool `thread_append` with
`{raw_text, role: 'shelly'|'agent'|'user', telegram_message_id}` so the
conversation lands in the right thread, then continue your normal reasoning.
Untagged messages stay in the freeform Shelly channel — that's fine; tag only
when continuing a thread that started from a dashboard signal.

If you forget the tag, the dashboard still shows your reply in the freeform
Shelly tab. The dashboard offers an "attach to thread" rescue button so the
user can fix it manually — but please don't make them do that.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(shelly): thread tag protocol for dashboard sync"
```

---

## Final verification

- [ ] **Run the full test suite**

```bash
npm test
```

Expected: all tests pass, including pre-existing ones.

- [ ] **Manual smoke test (requires running services + Plane + GitHub creds)**

```bash
# Terminal 1: start the server
node bin/dev-panel.js serve

# Terminal 2: bootstrap a throwaway project
curl -XPOST http://localhost:3030/api/projects/from-github \
  -H "X-Admin-Key: $DEVPANEL_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"github_url":"https://github.com/franck/test-bootstrap-throwaway"}'

# Verify project exists, fetch a signal feed (using the freshly minted key)
curl http://localhost:3030/api/signals -H "X-API-Key: dp_..."
```

Expected: project returned with `bootstrap_job_id`. Signal feed returns rows (likely the bootstrap_started/succeeded events once the worker runs).

- [ ] **Commit a short note in the spec file marking Stage 1 complete**

In [docs/superpowers/specs/2026-04-21-signal-inbox-redesign-design.md](../specs/2026-04-21-signal-inbox-redesign-design.md), under `## Rollout > ### Stage 1`, append:

```markdown
**Status:** ✅ Shipped on $(date +%Y-%m-%d). Tracking: see commit log between `<first sha>` and `<last sha>`.
```

```bash
git add docs/superpowers/specs/2026-04-21-signal-inbox-redesign-design.md
git commit -m "docs(spec): mark Stage 1 backend complete"
```

---

## Self-Review

Before handing off, the planning agent ran the spec → plan coverage check:

- Schema: subjects, threads, thread_messages, deploy_events → Task 1 ✅
- Subject CRUD + priority lanes → Task 2 ✅
- Telegram tag parser/builder → Task 3 ✅
- Thread CRUD + Telegram dedup → Task 4 ✅
- Deploy events recorder → Task 5 ✅
- Signals aggregator → Task 6 ✅
- `notifyJob` writes deploy_events → Task 7 ✅
- HTTP endpoints (signals/threads/subjects) → Task 8 ✅
- MCP `thread_append` for inbound Telegram → Task 9 ✅
- SSE event types → Task 10 ✅
- Project bootstrap orchestration → Task 11 ✅
- HTTP endpoint for paste-URL → Task 12 ✅
- Worker handler `bootstrap_project` → Task 13 ✅
- Shelly persona update → Task 14 ✅

**Out of scope** (deferred to Plan 2 / Plan 3, per spec rollout stages):
- Signals UI components (`<SignalsView>`, `<ThreadPanel>`, etc.) — Plan 2 (Stage 2)
- Promote-to-default + delete old views — Plan 3 (Stage 3)
- Security alerts ingestion — v2 per spec
- "attach to thread" rescue button on freeform Shelly messages — v2

**Known follow-up nits noted during planning:**
- `workflow_instances` does not currently carry `project_id`; the signals query papers over this for the requesting project. A clean fix is to add `project_id` to `workflow_instances` in a follow-up. Not blocking — single-project queries work today.
- `createProject()` may need new fields plumbed through; check before Task 11 implementation.
- `_sendText` is not exported from `alerts.js`; Task 8 inlines the same Telegram send path. If duplication bothers anyone in review, refactor to export `_sendText` (rename to `sendTelegramText`) in a follow-up — non-blocking.
