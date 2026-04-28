# PR Merge → Release Broadcast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When GitHub fires `pull_request.closed` with `merged=true` on any repo wired to the DevPanel webhook, fan a plain-text release note out to every active row in `dev_bots`.

**Architecture:** Extend the existing `webhooks-github.js` handler from branch `feat/wi-7096cee4-github-pr-webhook-shelly-dispatc` (not yet on `main`) with a closed+merged branch. New `src/server/release-notes.js` builds the note (title, author, stats, commit bullets, optional Plane cycle link) and fans out via direct `sendMessage` calls to each bot's token. Idempotence via a new `release_broadcasts` table keyed on `github:<repo>#<pr>:merged`.

**Tech Stack:** Node ESM, Express, vitest (`npm run test`), pg pool (`src/server/pg.js`), GitHub REST API, Plane REST API, Telegram Bot API (push-only).

**Branch strategy:** Base this work on `origin/feat/wi-7096cee4-github-pr-webhook-shelly-dispatc`, not `main`. The webhook handler we are extending lives there.

---

## Task 1: Set up the working branch

**Files:**
- None (git plumbing only)

- [ ] **Step 1: Create a worktree based on the merge-coordinator branch**

```bash
git fetch origin
git worktree add .claude/worktrees/release-broadcast \
  -b feat/release-broadcast \
  origin/feat/wi-7096cee4-github-pr-webhook-shelly-dispatc
cd .claude/worktrees/release-broadcast
```

- [ ] **Step 2: Verify the webhook handler is present**

Run: `ls src/server/webhooks-github.js && head -5 src/server/webhooks-github.js`
Expected: file exists, first lines mention `GitHub webhook handler for pull_request events`.

- [ ] **Step 3: Confirm tests pass before any change**

Run: `npm install && npm run test -- tests/server/webhooks-github.test.js`
Expected: all tests in that file pass (this is the baseline we extend).

---

## Task 2: Migration — `release_broadcasts` table

**Files:**
- Create: `infra/migrations/008-release-broadcasts.sql`

- [ ] **Step 1: Write the migration SQL**

Create `infra/migrations/008-release-broadcasts.sql`:

```sql
-- 008-release-broadcasts.sql
-- One row per (repo, pr_number, merged) broadcast. Used purely for
-- idempotence: GitHub re-delivers webhook events; we only fan out to
-- the team once per merge.

BEGIN;

CREATE TABLE IF NOT EXISTS release_broadcasts (
  synthetic_id  TEXT PRIMARY KEY,
  broadcast_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
```

- [ ] **Step 2: Verify migration applies cleanly against a local pg**

Run (only if a local pg with the dev schema is reachable):
```bash
psql "$DATABASE_URL" -f infra/migrations/008-release-broadcasts.sql
psql "$DATABASE_URL" -c "\d release_broadcasts"
```
Expected: table created with two columns; second run is a no-op (`CREATE TABLE IF NOT EXISTS`).

If no local pg is available, skip this step — the migration runner on services VPS picks up new SQL files automatically on deploy. Test coverage in Task 6 validates the row insert/replay behavior with an in-memory mock.

- [ ] **Step 3: Commit**

```bash
git add infra/migrations/008-release-broadcasts.sql
git commit -m "feat(db): release_broadcasts idempotence table"
```

---

## Task 3: `recordBroadcast` — idempotence helper

**Files:**
- Create: `src/server/release-notes.js`
- Test: `tests/server/release-notes.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/server/release-notes.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../../src/server/pg.js', () => ({
  pool: { query: (...args) => queryMock(...args) }
}));

import { recordBroadcast } from '../../src/server/release-notes.js';

describe('recordBroadcast', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns inserted=true when the row is new', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ synthetic_id: 'github:owner/repo#42:merged' }] });
    const r = await recordBroadcast('github:owner/repo#42:merged');
    expect(r).toEqual({ inserted: true });
    expect(queryMock).toHaveBeenCalledOnce();
    const sql = queryMock.mock.calls[0][0];
    expect(sql).toMatch(/INSERT INTO release_broadcasts/);
    expect(sql).toMatch(/ON CONFLICT.*DO NOTHING/i);
    expect(sql).toMatch(/RETURNING/i);
    expect(queryMock.mock.calls[0][1]).toEqual(['github:owner/repo#42:merged']);
  });

  it('returns inserted=false when the row already existed', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const r = await recordBroadcast('github:owner/repo#42:merged');
    expect(r).toEqual({ inserted: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/server/release-notes.test.js`
Expected: FAIL with `Cannot find module '../../src/server/release-notes.js'` (or similar import error).

- [ ] **Step 3: Write minimal implementation**

Create `src/server/release-notes.js`:

```js
// Build and broadcast a release note when a pull request gets merged.
// Triggered by webhooks-github.js on pull_request.closed + merged=true.

import { pool } from './pg.js';

export async function recordBroadcast(syntheticId) {
  const { rows } = await pool.query(
    `INSERT INTO release_broadcasts (synthetic_id)
     VALUES ($1)
     ON CONFLICT (synthetic_id) DO NOTHING
     RETURNING synthetic_id`,
    [syntheticId]
  );
  return { inserted: rows.length > 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/server/release-notes.test.js`
Expected: 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/release-notes.js tests/server/release-notes.test.js
git commit -m "feat(release-notes): recordBroadcast idempotence helper"
```

---

## Task 4: `buildReleaseNote` — pure formatting

**Files:**
- Modify: `src/server/release-notes.js`
- Modify: `tests/server/release-notes.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/server/release-notes.test.js`:

```js
import { buildReleaseNote } from '../../src/server/release-notes.js';

describe('buildReleaseNote', () => {
  const pr = {
    number: 42,
    title: 'Flight-deck Phase 5',
    user: { login: 'franckbirba' },
    changed_files: 17,
    additions: 482,
    deletions: 103
  };
  const repo = 'franckbirba/dev-panel';
  const commits = [
    { sha: 'a284af8aaa', commit: { message: 'fix(flight-deck): real Approve/Retry/Reply actions\n\nbody ignored' } },
    { sha: '364593dbbb', commit: { message: 'Inbox / Fleet / Memory + real liveness' } }
  ];

  it('formats header, author, stats and commit bullets', () => {
    const note = buildReleaseNote({ pr, repo, commits, cycle: null });
    expect(note).toContain('Merged — franckbirba/dev-panel #42: Flight-deck Phase 5');
    expect(note).toContain('by @franckbirba');
    expect(note).toContain('17 files, +482/-103');
    expect(note).toContain('• a284af8 fix(flight-deck): real Approve/Retry/Reply actions');
    expect(note).toContain('• 364593d Inbox / Fleet / Memory + real liveness');
    expect(note).not.toContain('body ignored');
    expect(note).not.toMatch(/Cycle:/);
  });

  it('caps commits at 8 and appends "(+N more)"', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      sha: String(i).padStart(10, '0'),
      commit: { message: `commit ${i}` }
    }));
    const note = buildReleaseNote({ pr, repo, commits: many, cycle: null });
    const bullets = note.split('\n').filter(l => l.startsWith('• '));
    expect(bullets).toHaveLength(8);
    expect(note).toContain('(+3 more)');
  });

  it('shows "(commits unavailable)" when commits is null', () => {
    const note = buildReleaseNote({ pr, repo, commits: null, cycle: null });
    expect(note).toContain('(commits unavailable)');
    expect(note).not.toMatch(/^•/m);
  });

  it('appends Cycle line when cycle is provided', () => {
    const cycle = { name: 'Sprint 14', url: 'https://plane.devpanl.dev/devpanl/projects/abc/cycles/xyz/' };
    const note = buildReleaseNote({ pr, repo, commits, cycle });
    expect(note).toContain('Cycle: Sprint 14 — https://plane.devpanl.dev/devpanl/projects/abc/cycles/xyz/');
  });

  it('omits Cycle line when cycle is null', () => {
    const note = buildReleaseNote({ pr, repo, commits, cycle: null });
    expect(note).not.toMatch(/Cycle:/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/server/release-notes.test.js`
Expected: 5 new failures with `buildReleaseNote is not a function` (or undefined import).

- [ ] **Step 3: Implement `buildReleaseNote`**

Append to `src/server/release-notes.js`:

```js
const COMMIT_CAP = 8;

export function buildReleaseNote({ pr, repo, commits, cycle }) {
  const author = pr.user?.login || 'unknown';
  const filesChanged = pr.changed_files ?? 0;
  const additions = pr.additions ?? 0;
  const deletions = pr.deletions ?? 0;

  const lines = [
    `Merged — ${repo} #${pr.number}: ${pr.title || '(no title)'}`,
    `by @${author}  ·  ${filesChanged} files, +${additions}/-${deletions}`,
    ''
  ];

  if (commits === null || commits === undefined) {
    lines.push('(commits unavailable)');
  } else {
    const shown = commits.slice(0, COMMIT_CAP);
    for (const c of shown) {
      const subject = (c.commit?.message || '').split('\n')[0];
      const sha7 = String(c.sha || '').slice(0, 7);
      lines.push(`• ${sha7} ${subject}`);
    }
    if (commits.length > COMMIT_CAP) {
      lines.push(`(+${commits.length - COMMIT_CAP} more)`);
    }
  }

  if (cycle) {
    lines.push('');
    lines.push(`Cycle: ${cycle.name} — ${cycle.url}`);
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- tests/server/release-notes.test.js`
Expected: 7 passing tests (2 from Task 3 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/server/release-notes.js tests/server/release-notes.test.js
git commit -m "feat(release-notes): buildReleaseNote pure formatter"
```

---

## Task 5: `fetchCommits` — GitHub REST call

**Files:**
- Modify: `src/server/release-notes.js`
- Modify: `tests/server/release-notes.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/server/release-notes.test.js`:

```js
import { fetchCommits } from '../../src/server/release-notes.js';

describe('fetchCommits', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    process.env.GITHUB_TOKEN = 'test-token';
  });

  it('returns the commits array on 2xx', async () => {
    const fixture = [{ sha: 'aaa', commit: { message: 'a' } }];
    fetch.mockResolvedValueOnce({ ok: true, json: async () => fixture });
    const r = await fetchCommits('owner/repo', 42);
    expect(r).toEqual(fixture);
    const call = fetch.mock.calls[0];
    expect(call[0]).toBe('https://api.github.com/repos/owner/repo/pulls/42/commits?per_page=100');
    expect(call[1].headers.Authorization).toBe('Bearer test-token');
    expect(call[1].headers.Accept).toBe('application/vnd.github+json');
  });

  it('returns null on non-2xx', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const r = await fetchCommits('owner/repo', 42);
    expect(r).toBeNull();
  });

  it('returns null on network failure', async () => {
    fetch.mockRejectedValueOnce(new Error('boom'));
    const r = await fetchCommits('owner/repo', 42);
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/server/release-notes.test.js`
Expected: 3 new failures, `fetchCommits is not a function`.

- [ ] **Step 3: Implement `fetchCommits`**

Append to `src/server/release-notes.js`:

```js
export async function fetchCommits(repo, prNumber) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('[release-notes] GITHUB_TOKEN missing, cannot fetch commits');
    return null;
  }
  try {
    const r = await fetch(
      `https://api.github.com/repos/${repo}/pulls/${prNumber}/commits?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json'
        }
      }
    );
    if (!r.ok) {
      console.warn(`[release-notes] commits HTTP ${r.status} for ${repo}#${prNumber}`);
      return null;
    }
    return await r.json();
  } catch (err) {
    console.warn(`[release-notes] commits fetch failed for ${repo}#${prNumber}: ${err.message}`);
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- tests/server/release-notes.test.js`
Expected: 10 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/release-notes.js tests/server/release-notes.test.js
git commit -m "feat(release-notes): fetchCommits via GitHub REST"
```

---

## Task 6: `resolveCycle` — Plane API roundtrip

**Files:**
- Modify: `src/server/release-notes.js`
- Modify: `tests/server/release-notes.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/server/release-notes.test.js`:

```js
import { resolveCycle } from '../../src/server/release-notes.js';

describe('resolveCycle', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    process.env.PLANE_API_TOKEN = 'plane-tok';
    process.env.PLANE_WORKSPACE_SLUG = 'devpanl';
    process.env.PLANE_BASE_URL = 'https://plane.devpanl.dev';
  });

  it('returns null when planeRef is null', async () => {
    expect(await resolveCycle(null)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns null when no projects match the sequence prefix', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
      { id: 'p1', identifier: 'ZENO' }
    ] }) });
    const r = await resolveCycle({ type: 'sequence', project: 'DEVPA', number: 93 });
    expect(r).toBeNull();
  });

  it('returns null when there is no active cycle', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
        { id: 'p1', identifier: 'DEVPA' }
      ] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    const r = await resolveCycle({ type: 'sequence', project: 'DEVPA', number: 93 });
    expect(r).toBeNull();
  });

  it('returns {name, url} when an active cycle exists', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
        { id: 'p1', identifier: 'DEVPA' }
      ] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
        { id: 'c1', name: 'Sprint 14' }
      ] }) });
    const r = await resolveCycle({ type: 'sequence', project: 'DEVPA', number: 93 });
    expect(r).toEqual({
      name: 'Sprint 14',
      url: 'https://plane.devpanl.dev/devpanl/projects/p1/cycles/c1/'
    });
  });

  it('returns null when the projects fetch throws', async () => {
    fetch.mockRejectedValueOnce(new Error('plane down'));
    const r = await resolveCycle({ type: 'sequence', project: 'DEVPA', number: 93 });
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/server/release-notes.test.js`
Expected: 5 new failures, `resolveCycle is not a function`.

- [ ] **Step 3: Implement `resolveCycle`**

Append to `src/server/release-notes.js`:

```js
function planeConfig() {
  const base = (process.env.PLANE_BASE_URL || 'https://plane.devpanl.dev').replace(/\/$/, '');
  const slug = process.env.PLANE_WORKSPACE_SLUG || 'devpanl';
  const key = process.env.PLANE_API_TOKEN || process.env.PLANE_API_KEY || '';
  if (!key) return null;
  return { base, slug, key };
}

async function planeGet(cfg, path) {
  const r = await fetch(`${cfg.base}/api/v1/workspaces/${cfg.slug}${path}`, {
    headers: { 'X-API-Key': cfg.key },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.results || data || [];
}

export async function resolveCycle(planeRef) {
  if (!planeRef) return null;
  const cfg = planeConfig();
  if (!cfg) return null;

  try {
    let projectId = null;

    if (planeRef.type === 'sequence') {
      const projects = await planeGet(cfg, '/projects/');
      if (!projects) return null;
      const match = projects.find(p => p.identifier === planeRef.project);
      if (!match) return null;
      projectId = match.id;
    } else if (planeRef.type === 'uuid') {
      // We don't know which project hosts this work item without a lookup
      // loop. Walk projects and probe — same pattern as plane-enrich.js.
      const projects = await planeGet(cfg, '/projects/');
      if (!projects) return null;
      for (const p of projects) {
        const r = await fetch(
          `${cfg.base}/api/v1/workspaces/${cfg.slug}/projects/${p.id}/issues/${planeRef.value}/`,
          { headers: { 'X-API-Key': cfg.key }, signal: AbortSignal.timeout(5000) }
        ).catch(() => null);
        if (r && r.ok) { projectId = p.id; break; }
      }
      if (!projectId) return null;
    } else {
      return null;
    }

    const cycles = await planeGet(cfg, `/projects/${projectId}/cycles/active/`);
    if (!cycles || cycles.length === 0) return null;

    const cycle = cycles[0];
    return {
      name: cycle.name,
      url: `${cfg.base}/${cfg.slug}/projects/${projectId}/cycles/${cycle.id}/`
    };
  } catch (err) {
    console.warn(`[release-notes] resolveCycle failed: ${err.message}`);
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- tests/server/release-notes.test.js`
Expected: 15 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/release-notes.js tests/server/release-notes.test.js
git commit -m "feat(release-notes): resolveCycle via Plane active-cycle API"
```

---

## Task 7: `fanOut` — broadcast to active dev_bots

**Files:**
- Modify: `src/server/release-notes.js`
- Modify: `tests/server/release-notes.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/server/release-notes.test.js`:

```js
const listActiveMock = vi.fn();
vi.mock('../../src/server/dev-bots.js', () => ({
  listActive: (...a) => listActiveMock(...a)
}));

import { fanOut } from '../../src/server/release-notes.js';

describe('fanOut', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    listActiveMock.mockReset();
  });

  it('sends one Telegram message per bot with owner_tg_user_id', async () => {
    listActiveMock.mockResolvedValueOnce([
      { bot_token: 'tok-a', owner_tg_user_id: 111 },
      { bot_token: 'tok-b', owner_tg_user_id: 222 }
    ]);
    fetch.mockResolvedValue({ ok: true });

    await fanOut('hello team');

    expect(fetch).toHaveBeenCalledTimes(2);
    const urls = fetch.mock.calls.map(c => c[0]);
    expect(urls).toContain('https://api.telegram.org/bottok-a/sendMessage');
    expect(urls).toContain('https://api.telegram.org/bottok-b/sendMessage');
    const bodies = fetch.mock.calls.map(c => JSON.parse(c[1].body));
    expect(bodies).toEqual(expect.arrayContaining([
      { chat_id: 111, text: 'hello team' },
      { chat_id: 222, text: 'hello team' }
    ]));
  });

  it('skips bots without owner_tg_user_id', async () => {
    listActiveMock.mockResolvedValueOnce([
      { bot_token: 'tok-a', owner_tg_user_id: null },
      { bot_token: 'tok-b', owner_tg_user_id: 222 }
    ]);
    fetch.mockResolvedValue({ ok: true });

    await fanOut('hi');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain('tok-b');
  });

  it('does not throw when one bot fails', async () => {
    listActiveMock.mockResolvedValueOnce([
      { bot_token: 'tok-a', owner_tg_user_id: 111 },
      { bot_token: 'tok-b', owner_tg_user_id: 222 }
    ]);
    fetch
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true });

    await expect(fanOut('hi')).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns early when no active bots', async () => {
    listActiveMock.mockResolvedValueOnce([]);
    await fanOut('hi');
    expect(fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/server/release-notes.test.js`
Expected: 4 new failures, `fanOut is not a function`.

- [ ] **Step 3: Implement `fanOut`**

Append to `src/server/release-notes.js`:

```js
import { listActive } from './dev-bots.js';

async function sendTelegram(token, chatId, text) {
  if (!chatId) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!r.ok) console.warn(`[release-notes] sendMessage ${r.status} for chat=${chatId}`);
  } catch (err) {
    console.warn(`[release-notes] sendMessage failed for chat=${chatId}: ${err.message}`);
  }
}

export async function fanOut(text) {
  const bots = await listActive();
  if (!bots || bots.length === 0) {
    console.log('[release-notes] no active bots, skipping fan-out');
    return;
  }
  await Promise.allSettled(bots.map(b =>
    sendTelegram(b.bot_token, b.owner_tg_user_id, text)
  ));
}
```

Move the existing `import { pool } from './pg.js';` line so all imports stay at the top of the file (the previous tasks appended functions; this task adds another import — group them at the top).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- tests/server/release-notes.test.js`
Expected: 19 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/release-notes.js tests/server/release-notes.test.js
git commit -m "feat(release-notes): fanOut to active dev_bots"
```

---

## Task 8: `broadcastRelease` — orchestrator

**Files:**
- Modify: `src/server/release-notes.js`
- Modify: `tests/server/release-notes.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/server/release-notes.test.js`:

```js
import { broadcastRelease } from '../../src/server/release-notes.js';

describe('broadcastRelease', () => {
  const pr = {
    number: 42,
    title: 'Test PR',
    user: { login: 'me' },
    changed_files: 1, additions: 1, deletions: 0,
    head: { ref: 'feat/wi-7096cee4-foo-bar' }
  };

  beforeEach(() => {
    queryMock.mockReset();
    listActiveMock.mockReset();
    vi.stubGlobal('fetch', vi.fn());
    process.env.GITHUB_TOKEN = 'gh';
    process.env.PLANE_API_TOKEN = 'p';
  });

  it('inserts the broadcast row, fetches commits, and fans out', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ synthetic_id: 'github:owner/repo#42:merged' }] });
    fetch.mockResolvedValueOnce({ ok: true, json: async () => [
      { sha: 'abc1234', commit: { message: 'a' } }
    ] });
    // resolveCycle: projects fetch returns no match → null cycle
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    listActiveMock.mockResolvedValueOnce([{ bot_token: 't', owner_tg_user_id: 1 }]);
    fetch.mockResolvedValueOnce({ ok: true });

    const r = await broadcastRelease({ repo: 'owner/repo', pr });
    expect(r).toEqual({ broadcast: true });

    const tgCall = fetch.mock.calls.find(c => c[0].includes('api.telegram.org'));
    expect(tgCall).toBeDefined();
    const text = JSON.parse(tgCall[1].body).text;
    expect(text).toContain('Merged — owner/repo #42: Test PR');
    expect(text).toContain('• abc1234 a');
  });

  it('short-circuits when recordBroadcast says replay', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const r = await broadcastRelease({ repo: 'owner/repo', pr });
    expect(r).toEqual({ broadcast: false, reason: 'replay' });
    expect(fetch).not.toHaveBeenCalled();
    expect(listActiveMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/server/release-notes.test.js`
Expected: 2 new failures, `broadcastRelease is not a function`.

- [ ] **Step 3: Implement `broadcastRelease`**

Append to `src/server/release-notes.js`:

```js
// extractPlaneRef is exported by webhooks-github.js — reused here so the
// two webhook code paths interpret branch/title the same way.
import { extractPlaneRef } from './webhooks-github.js';

export function syntheticMergedId(repo, prNumber) {
  return `github:${repo}#${prNumber}:merged`;
}

export async function broadcastRelease({ repo, pr }) {
  const id = syntheticMergedId(repo, pr.number);
  const { inserted } = await recordBroadcast(id);
  if (!inserted) {
    console.log(`[release-notes] replay skipped for ${id}`);
    return { broadcast: false, reason: 'replay' };
  }

  const branch = pr.head?.ref;
  const planeRef = extractPlaneRef(branch, pr.title);

  const [commits, cycle] = await Promise.all([
    fetchCommits(repo, pr.number),
    resolveCycle(planeRef)
  ]);

  const text = buildReleaseNote({ pr, repo, commits, cycle });
  await fanOut(text);

  return { broadcast: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- tests/server/release-notes.test.js`
Expected: 21 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/release-notes.js tests/server/release-notes.test.js
git commit -m "feat(release-notes): broadcastRelease orchestrator"
```

---

## Task 9: Wire the webhook handler

**Files:**
- Modify: `src/server/webhooks-github.js`
- Create: `tests/server/webhooks-github-merged.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/server/webhooks-github-merged.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const broadcastMock = vi.fn();
const dispatchMock = vi.fn();
vi.mock('../../src/server/release-notes.js', () => ({
  broadcastRelease: (...a) => broadcastMock(...a)
}));

import { mountGitHubWebhook, __setDispatchForTests } from '../../src/server/webhooks-github.js';

function makeApp() {
  const app = express();
  mountGitHubWebhook(app);
  return app;
}

function payload(action, merged) {
  return {
    action,
    pull_request: {
      number: 42,
      title: 'Hello',
      merged,
      head: { sha: 'sha', ref: 'feat/wi-7096cee4-x' },
      body: ''
    },
    repository: { full_name: 'owner/repo' }
  };
}

describe('webhook closed+merged', () => {
  beforeEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    broadcastMock.mockReset();
    dispatchMock.mockReset();
    __setDispatchForTests(dispatchMock);
  });

  it('calls broadcastRelease on closed+merged=true', async () => {
    broadcastMock.mockResolvedValueOnce({ broadcast: true });
    const r = await request(makeApp())
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .send(payload('closed', true));
    expect(r.status).toBe(202);
    expect(broadcastMock).toHaveBeenCalledOnce();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('returns 204 when broadcast is a replay', async () => {
    broadcastMock.mockResolvedValueOnce({ broadcast: false, reason: 'replay' });
    const r = await request(makeApp())
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .send(payload('closed', true));
    expect(r.status).toBe(204);
  });

  it('does nothing on closed+merged=false', async () => {
    const r = await request(makeApp())
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .send(payload('closed', false));
    expect(r.status).toBe(204);
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('still dispatches merge-coordinator on opened (regression)', async () => {
    dispatchMock.mockResolvedValueOnce({ ok: true, instance_id: 'i1', job_id: 'j1' });
    const r = await request(makeApp())
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .send(payload('opened', false));
    expect(r.status).toBe(201);
    expect(dispatchMock).toHaveBeenCalledOnce();
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
```

Note: if `supertest` is not yet a dev dep, add it: `npm install -D supertest`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/server/webhooks-github-merged.test.js`
Expected: failures because the handler doesn't branch on closed+merged yet.

- [ ] **Step 3: Modify `src/server/webhooks-github.js`**

Find the line `const ALLOWED_ACTIONS = new Set(['opened', 'reopened', 'synchronize']);` and replace it with:

```js
const ALLOWED_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'closed']);
```

Then find the block that begins with `// Filter: only opened / reopened / synchronize` and ends just before the existing `// Idempotence:` block. Replace:

```js
        // Filter: only opened / reopened / synchronize
        if (!ALLOWED_ACTIONS.has(payload.action)) return res.status(204).end();

        const pr = payload.pull_request;
        if (!pr) return res.status(400).json({ error: 'missing pull_request' });

        const repo = payload.repository?.full_name;
        const prNumber = pr.number;
        const headSha = pr.head?.sha;
        const branch = pr.head?.ref;
        const prTitle = pr.title;

        if (!repo || !prNumber) {
          return res.status(400).json({ error: 'missing repo or pr number' });
        }
```

with the same block plus a closed+merged early branch immediately after the validation:

```js
        // Filter: only opened / reopened / synchronize / closed
        if (!ALLOWED_ACTIONS.has(payload.action)) return res.status(204).end();

        const pr = payload.pull_request;
        if (!pr) return res.status(400).json({ error: 'missing pull_request' });

        const repo = payload.repository?.full_name;
        const prNumber = pr.number;
        const headSha = pr.head?.sha;
        const branch = pr.head?.ref;
        const prTitle = pr.title;

        if (!repo || !prNumber) {
          return res.status(400).json({ error: 'missing repo or pr number' });
        }

        // Closed + merged → release-note broadcast, never dispatch merge-coordinator.
        if (payload.action === 'closed') {
          if (!pr.merged) return res.status(204).end();
          const { broadcastRelease } = await import('./release-notes.js');
          const result = await broadcastRelease({ repo, pr });
          return res.status(result.broadcast ? 202 : 204).end();
        }
```

The dynamic `import('./release-notes.js')` keeps the existing handler bootable even on instances where the new file is somehow missing (defensive — same pattern already used for `getDispatch()` in this file).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- tests/server/webhooks-github-merged.test.js tests/server/webhooks-github.test.js`
Expected: all closed+merged tests pass; existing webhook tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/webhooks-github.js tests/server/webhooks-github-merged.test.js package.json package-lock.json
git commit -m "feat(webhooks-github): closed+merged → broadcastRelease"
```

---

## Task 10: Full test suite + push

**Files:**
- None (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npm run test`
Expected: all tests pass. If anything outside our scope fails, check `MEMORY.md` → `flaky_bootstrap_test.md` for known flakes; rerun the failing file alone to disambiguate.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/release-broadcast
```

- [ ] **Step 3: Open PR (manual)**

Use `gh pr create --base feat/wi-7096cee4-github-pr-webhook-shelly-dispatc --title "feat: release-note broadcast on PR merge" --body-file -` and paste a body that references the spec (`docs/superpowers/specs/2026-04-28-pr-merge-release-broadcast-design.md`). Targeting the merge-coordinator branch (not `main`) keeps the diff focused on the broadcast addition.

When the merge-coordinator branch lands on `main`, rebase this PR onto `main` and merge.

---

## Self-review notes

- **Spec coverage:**
  - "trigger on pr.merged=true" → Task 9.
  - "release_broadcasts table for idempotence" → Tasks 2, 3.
  - "format: header, author, stats, commit bullets, optional Cycle line" → Task 4.
  - "fetchCommits via GitHub REST" → Task 5.
  - "resolveCycle via Plane active-cycle endpoint" → Task 6.
  - "fan-out via direct sendMessage to dev_bots" → Task 7.
  - "broadcastRelease orchestrator" → Task 8.
  - "no PR/work-item link, only Cycle link" → enforced in Task 4 tests (`expect(...).not.toContain(pr_html_url-style strings)` is implicit — the `buildReleaseNote` signature has no `pr_html_url` field, so it cannot leak in).
  - "closed+merged=false silent" → Task 9 test.
  - "regression: opened still dispatches merge-coordinator" → Task 9 test.
- **No placeholders** — every step has the exact code or command needed.
- **Type/name consistency** — `recordBroadcast`, `buildReleaseNote`, `fetchCommits`, `resolveCycle`, `fanOut`, `broadcastRelease`, `syntheticMergedId` are referenced consistently across tasks. `extractPlaneRef` is already exported by `webhooks-github.js` (verified in branch source).
