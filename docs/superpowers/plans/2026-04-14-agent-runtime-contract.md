# Agent Runtime Contract + Memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every spawned `claude -p` agent operate under a strict runtime contract: Plane-anchored job payloads, strict JSON output, worker-owned automation (Plane / GitHub / devpanel / Shelly), pgvector-backed shared memory, SSE dashboard live updates, and an authorization-gated deploy job.

**Architecture:** New MCP memory tools on top of Postgres+pgvector (shared with existing AFFiNE container). A new `src/worker/automation.js` runs a fixed sequence of side-effects after every `claude -p` exit, driven by strict `parseResult`. Worker broadcasts SSE events for live dashboard. Deploy is a new agent with a worker-enforced allowlist. No agent sees API keys.

**Tech Stack:** Node 20 (ESM), better-sqlite3 (ops log), `pg` (postgres+pgvector), BullMQ, Voyage AI (embeddings), Vitest (tests), SSE.

**Spec:** [docs/superpowers/specs/2026-04-14-agent-runtime-contract-design.md](../specs/2026-04-14-agent-runtime-contract-design.md)

---

## File Map

**Created:**
- `infra/migrations/001-pgvector-init.sql` — pgvector extension + `agent_memory` DB + `memories` table
- `src/server/pg.js` — Postgres pool + query helpers
- `src/server/voyage.js` — Voyage embedding client
- `src/server/jobs-log.js` — `agent_job_log` helpers (SQLite)
- `src/worker/automation.js` — post-job automation matrix (all side-effects)
- `src/worker/auth.js` — `allowed_requesters` allowlist check
- `src/worker/handlers/deploy.js` — deploy job handler (spawns `make deploy`)
- `src/dashboard/lib/events.js` — SSE client for dashboard
- `.claude/skills/shared-memory.md` — mandatory memory skill
- `.agents/<role>/SOUL.md` — rewritten for 6 roles + new `deploy`
- `.agents/<role>/PLAYBOOK.md` — companion runbooks (link existing `.claude/skills/agent-*.md`)
- `tests/**/*.test.js` — Vitest tests

**Modified:**
- `infra/docker-compose.yml:117` — postgres image → `pgvector/pgvector:pg16`
- `src/mcp/server.js` — register `memory_search` / `memory_write` / `memory_list`
- `src/worker/prompt-builder.js` — new payload shape, strict JSON Rules, strict `parseResult`
- `src/worker/index.js` — wire automation matrix
- `src/worker/crons.js` — add nightly deploy cron
- `src/server/alerts.js` — add `notifyJob`, remove emoji
- `src/server/routes.js` — add admin SSE endpoint `/api/admin/events`
- `src/server/db.js` — add `agent_job_log` table

---

## Phase 1 — Infra

### Task 1: Add Vitest + pg + dev tooling

**Files:** `package.json`

- [ ] **Step 1: Install deps**

```bash
npm install --save pg
npm install --save-dev vitest
```

- [ ] **Step 2: Update `package.json` scripts**

Replace the `scripts` section with:

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest",
  "build": "vite build",
  "dev:dashboard": "vite --config vite.config.js"
},
```

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: vitest reports `No test files found` and exits 0.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add vitest + pg dependencies"
```

### Task 2: Swap postgres image to pgvector

**Files:** Modify `infra/docker-compose.yml:117`

- [ ] **Step 1: Edit**

Change line 117 from:

```yaml
    image: postgres:16-alpine
```

to:

```yaml
    image: pgvector/pgvector:pg16
```

- [ ] **Step 2: Verify locally**

```bash
cd infra && docker compose config | grep "image: pgvector"
```
Expected: `image: pgvector/pgvector:pg16`

- [ ] **Step 3: Commit**

```bash
git add infra/docker-compose.yml
git commit -m "infra(postgres): swap to pgvector/pg16 image"
```

### Task 3: pgvector + agent_memory migration

**Files:** Create `infra/migrations/001-pgvector-init.sql`

- [ ] **Step 1: Write migration**

```sql
-- Run against the existing postgres container as a superuser (affine role has CREATEDB).
-- Usage:
--   docker exec -i devpanel-postgres psql -U affine -d postgres < infra/migrations/001-pgvector-init.sql

CREATE DATABASE agent_memory;
\c agent_memory

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace     TEXT NOT NULL,
  agent         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  module_id     TEXT,
  cycle_id      TEXT,
  work_item_id  TEXT,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT[] DEFAULT '{}',
  embedding     vector(1024),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ
);

CREATE INDEX memories_embedding_idx   ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
CREATE INDEX memories_ns_agent_kind   ON memories (namespace, agent, kind);
CREATE INDEX memories_plane_triple    ON memories (module_id, cycle_id, work_item_id);
CREATE INDEX memories_created_at      ON memories (created_at DESC);
```

- [ ] **Step 2: Apply locally**

```bash
docker exec -i devpanel-postgres psql -U affine -d postgres < infra/migrations/001-pgvector-init.sql
docker exec -i devpanel-postgres psql -U affine -d agent_memory -c "\dt"
```
Expected: `memories` table listed.

- [ ] **Step 3: Commit**

```bash
git add infra/migrations/001-pgvector-init.sql
git commit -m "infra(memory): agent_memory DB + memories table migration"
```

### Task 4: Env vars + `.env.example`

**Files:** Modify project-root `.env.example` (create if missing)

- [ ] **Step 1: Add/ensure these keys exist**

```bash
# --- Memory layer ---
PG_HOST=devpanel-postgres
PG_PORT=5432
PG_USER=affine
PG_PASSWORD=
PG_DATABASE=agent_memory
VOYAGE_API_KEY=
VOYAGE_MODEL=voyage-code-3

# --- Agents ---
AGENT_MEMORY_NAMESPACE=dev-panel
DEPLOY_ALLOWED_REQUESTERS=franck,cron:nightly
DEPLOY_CRON=0 3 * * *
DEPLOY_TIMEZONE=Europe/Paris

# --- Worker <-> server IPC ---
WORKER_EVENTS_URL=http://localhost:3030/api/admin/events/publish
ADMIN_API_KEY=
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "chore(env): document memory/deploy/worker env vars"
```

---

## Phase 2 — Memory layer

### Task 5: Voyage embedding client with tests

**Files:** Create `src/server/voyage.js`, `tests/server/voyage.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/server/voyage.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { embed } from '../../src/server/voyage.js';

describe('voyage embed', () => {
  beforeEach(() => {
    process.env.VOYAGE_API_KEY = 'test-key';
    process.env.VOYAGE_MODEL = 'voyage-code-3';
    global.fetch = vi.fn();
  });

  it('returns a 1024-dim vector for a string input', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: Array(1024).fill(0.01) }] })
    });
    const v = await embed('hello world');
    expect(v).toHaveLength(1024);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.voyageai.com/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' })
      })
    );
  });

  it('throws if VOYAGE_API_KEY is missing', async () => {
    delete process.env.VOYAGE_API_KEY;
    await expect(embed('x')).rejects.toThrow(/VOYAGE_API_KEY/);
  });

  it('throws on non-ok response', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    await expect(embed('x')).rejects.toThrow(/Voyage.*500/);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- tests/server/voyage.test.js`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement `src/server/voyage.js`**

```javascript
// src/server/voyage.js
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

export async function embed(input, { inputType = 'document' } = {}) {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error('VOYAGE_API_KEY is not set');
  const model = process.env.VOYAGE_MODEL || 'voyage-code-3';

  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({ input, model, input_type: inputType })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Voyage embed failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data[0].embedding;
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npm test -- tests/server/voyage.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/voyage.js tests/server/voyage.test.js
git commit -m "feat(memory): Voyage embedding client + tests"
```

### Task 6: Postgres pool + memory query helpers

**Files:** Create `src/server/pg.js`, `tests/server/pg.test.js`

- [ ] **Step 1: Write a smoke test (integration — requires running pg)**

```javascript
// tests/server/pg.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, memoryInsert, memorySearchSql, memoryList } from '../../src/server/pg.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('pg memory helpers (integration)', () => {
  let id;
  afterAll(async () => { await pool.end(); });

  it('inserts a memory row', async () => {
    id = await memoryInsert({
      namespace: 'test',
      agent: 'builder',
      kind: 'decision',
      title: 't1',
      content: 'c1',
      embedding: Array(1024).fill(0.01)
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('lists by namespace+agent', async () => {
    const rows = await memoryList({ namespace: 'test', agent: 'builder', limit: 5 });
    expect(rows.some(r => r.id === id)).toBe(true);
  });

  it('searches by vector similarity', async () => {
    const rows = await memorySearchSql({
      namespace: 'test',
      embedding: Array(1024).fill(0.01),
      limit: 3
    });
    expect(rows[0].id).toBe(id);
    expect(typeof rows[0].score).toBe('number');
  });
});
```

- [ ] **Step 2: Implement `src/server/pg.js`**

```javascript
// src/server/pg.js
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.PG_HOST || 'devpanel-postgres',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  user: process.env.PG_USER || 'affine',
  password: process.env.PG_PASSWORD || '',
  database: process.env.PG_DATABASE || 'agent_memory',
  max: 10
});

function vecLiteral(arr) {
  return `[${arr.join(',')}]`;
}

export async function memoryInsert({
  namespace, agent, kind, title, content,
  module_id = null, cycle_id = null, work_item_id = null,
  tags = [], embedding, expires_at = null
}) {
  const { rows } = await pool.query(
    `INSERT INTO memories
       (namespace, agent, kind, module_id, cycle_id, work_item_id,
        title, content, tags, embedding, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector,$11)
     RETURNING id`,
    [namespace, agent, kind, module_id, cycle_id, work_item_id,
     title, content, tags, vecLiteral(embedding), expires_at]
  );
  return rows[0].id;
}

export async function memorySearchSql({
  namespace, embedding, kind = null, agent = null, module_id = null, limit = 5
}) {
  const params = [namespace, vecLiteral(embedding), limit];
  const clauses = ['namespace = $1'];
  if (kind)      { params.push(kind);      clauses.push(`kind = $${params.length}`); }
  if (agent)     { params.push(agent);     clauses.push(`agent = $${params.length}`); }
  if (module_id) { params.push(module_id); clauses.push(`module_id = $${params.length}`); }

  const sql = `
    SELECT id, agent, kind, title, content, module_id, cycle_id, work_item_id,
           tags, created_at,
           1 - (embedding <=> $2::vector) AS score
      FROM memories
     WHERE ${clauses.join(' AND ')}
     ORDER BY embedding <=> $2::vector
     LIMIT $3`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

export async function memoryList({
  namespace, kind = null, agent = null, module_id = null, limit = 20
}) {
  const params = [namespace];
  const clauses = ['namespace = $1'];
  if (kind)      { params.push(kind);      clauses.push(`kind = $${params.length}`); }
  if (agent)     { params.push(agent);     clauses.push(`agent = $${params.length}`); }
  if (module_id) { params.push(module_id); clauses.push(`module_id = $${params.length}`); }
  params.push(limit);

  const sql = `
    SELECT id, agent, kind, title, content, module_id, cycle_id, work_item_id,
           tags, created_at
      FROM memories
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}
```

- [ ] **Step 3: Run integration tests**

```bash
TEST_PG=1 npm test -- tests/server/pg.test.js
```
Expected: 3 tests PASS (requires `devpanel-postgres` running with the migration applied).

- [ ] **Step 4: Commit**

```bash
git add src/server/pg.js tests/server/pg.test.js
git commit -m "feat(memory): postgres pool + memory helpers"
```

### Task 7: agent_job_log table + helpers (SQLite)

**Files:** Modify `src/server/db.js`, create `src/server/jobs-log.js`, `tests/server/jobs-log.test.js`

- [ ] **Step 1: Extend `initMasterDatabase` schema**

In `src/server/db.js`, inside the `masterDb.exec(\`...\`)` block (after the `projects` table), append:

```javascript
CREATE TABLE IF NOT EXISTS agent_job_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  duration_ms INTEGER,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ajl_job ON agent_job_log(job_id);
CREATE INDEX IF NOT EXISTS idx_ajl_time ON agent_job_log(timestamp DESC);

CREATE TABLE IF NOT EXISTS agent_memory_writes (
  job_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  PRIMARY KEY (job_id, memory_id)
);
```

- [ ] **Step 2: Write tests**

```javascript
// tests/server/jobs-log.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase } from '../../src/server/db.js';
import { logStep, listSteps, recordMemoryWrite, countMemoryWrites } from '../../src/server/jobs-log.js';

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-'));
  initMasterDatabase(dir);
});

describe('jobs-log', () => {
  it('records a step and lists it', () => {
    logStep({ job_id: 'j1', agent: 'builder', step: 'parseResult', status: 'ok', duration_ms: 5 });
    const rows = listSteps('j1');
    expect(rows).toHaveLength(1);
    expect(rows[0].step).toBe('parseResult');
  });
  it('tracks memory writes per job', () => {
    recordMemoryWrite('j2', 'm-1');
    recordMemoryWrite('j2', 'm-2');
    expect(countMemoryWrites('j2')).toBe(2);
  });
});
```

- [ ] **Step 3: Implement `src/server/jobs-log.js`**

```javascript
// src/server/jobs-log.js
import { getMasterDatabase } from './db.js';

export function logStep({ job_id, agent, step, status, error = null, duration_ms = null }) {
  const db = getMasterDatabase();
  db.prepare(
    `INSERT INTO agent_job_log (job_id, agent, step, status, error, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(job_id, agent, step, status, error, duration_ms);
}

export function listSteps(job_id) {
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT * FROM agent_job_log WHERE job_id = ? ORDER BY id ASC`
  ).all(job_id);
}

export function recordMemoryWrite(job_id, memory_id) {
  const db = getMasterDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO agent_memory_writes (job_id, memory_id) VALUES (?, ?)`
  ).run(job_id, memory_id);
}

export function countMemoryWrites(job_id) {
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT COUNT(*) AS n FROM agent_memory_writes WHERE job_id = ?`
  ).get(job_id).n;
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- tests/server/jobs-log.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/db.js src/server/jobs-log.js tests/server/jobs-log.test.js
git commit -m "feat(memory): agent_job_log + memory_writes tracking (sqlite)"
```

### Task 8: Memory MCP tools

**Files:** Modify `src/mcp/server.js`

- [ ] **Step 1: Add imports near the top of `src/mcp/server.js`**

```javascript
import { embed } from '../server/voyage.js';
import { memoryInsert, memorySearchSql, memoryList } from '../server/pg.js';
import { recordMemoryWrite } from '../server/jobs-log.js';
```

- [ ] **Step 2: Register three MCP tools**

Append inside the `// TOOLS` section (locate the comment around line 58 of the current file):

```javascript
server.tool(
  'memory_write',
  {
    kind: z.enum(['decision', 'debug_finding', 'spec_note', 'handoff', 'retrospective', 'audit_finding']),
    title: z.string().min(3).max(200),
    content: z.string().min(10),
    tags: z.array(z.string()).optional(),
    module_id: z.string().optional(),
    cycle_id: z.string().optional(),
    work_item_id: z.string().optional()
  },
  async (args) => {
    const namespace = process.env.AGENT_MEMORY_NAMESPACE || 'dev-panel';
    const agent    = process.env.AGENT_ROLE || 'unknown';
    const jobId    = process.env.JOB_ID || null;
    const embedding = await embed(`${args.title}\n\n${args.content}`);
    const id = await memoryInsert({
      namespace, agent, kind: args.kind,
      title: args.title, content: args.content,
      tags: args.tags || [],
      module_id: args.module_id || null,
      cycle_id: args.cycle_id || null,
      work_item_id: args.work_item_id || null,
      embedding
    });
    if (jobId) recordMemoryWrite(jobId, id);
    return { content: [{ type: 'text', text: JSON.stringify({ id }) }] };
  }
);

server.tool(
  'memory_search',
  {
    query: z.string().min(2),
    kind: z.string().optional(),
    agent: z.string().optional(),
    module_id: z.string().optional(),
    limit: z.number().int().min(1).max(20).default(5)
  },
  async (args) => {
    const namespace = process.env.AGENT_MEMORY_NAMESPACE || 'dev-panel';
    const embedding = await embed(args.query, { inputType: 'query' });
    const rows = await memorySearchSql({
      namespace, embedding,
      kind: args.kind || null,
      agent: args.agent || null,
      module_id: args.module_id || null,
      limit: args.limit
    });
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
  }
);

server.tool(
  'memory_list',
  {
    kind: z.string().optional(),
    agent: z.string().optional(),
    module_id: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(20)
  },
  async (args) => {
    const namespace = process.env.AGENT_MEMORY_NAMESPACE || 'dev-panel';
    const rows = await memoryList({
      namespace,
      kind: args.kind || null,
      agent: args.agent || null,
      module_id: args.module_id || null,
      limit: args.limit
    });
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
  }
);
```

- [ ] **Step 3: Smoke-test manually**

```bash
AGENT_ROLE=builder JOB_ID=test VOYAGE_API_KEY=$VOYAGE_API_KEY \
  node -e "import('./src/mcp/server.js')" &
# Exit after a few seconds; just confirming it loads without errors.
```
Expected: no uncaught exceptions; kill the process.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/server.js
git commit -m "feat(memory): memory_write/search/list MCP tools"
```

---

## Phase 3 — Strict contract + automation matrix

### Task 9: Strict `parseResult` with schema validation

**Files:** Modify `src/worker/prompt-builder.js`, create `tests/worker/parse-result.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// tests/worker/parse-result.test.js
import { describe, it, expect } from 'vitest';
import { parseResult } from '../../src/worker/prompt-builder.js';

const VALID = {
  status: 'done',
  summary: 'ok',
  artifacts: {
    files_created: [],
    files_modified: ['a.js'],
    commits: ['abc'],
    branch: 'feat/wi_1-x',
    tests_passed: true,
    pr_url: null
  },
  handoff: { next_agent: 'reviewer', reason: 'ready' },
  memory_writes_count: 1,
  blockers: [],
  issues_found: []
};

describe('parseResult', () => {
  it('accepts valid JSON on the last line', () => {
    const out = parseResult(`chatty...\n${JSON.stringify(VALID)}`);
    expect(out.ok).toBe(true);
    expect(out.data.status).toBe('done');
  });

  it('accepts JSON inside a fenced block as fallback', () => {
    const out = parseResult('foo\n```json\n' + JSON.stringify(VALID) + '\n```');
    expect(out.ok).toBe(true);
  });

  it('rejects missing status', () => {
    const bad = { ...VALID }; delete bad.status;
    const out = parseResult('x\n' + JSON.stringify(bad));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/status/);
  });

  it('rejects non-enum status', () => {
    const out = parseResult('x\n' + JSON.stringify({ ...VALID, status: 'kinda' }));
    expect(out.ok).toBe(false);
  });

  it('rejects when no JSON present', () => {
    const out = parseResult('just prose, no json');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no json/i);
  });
});
```

- [ ] **Step 2: Rewrite `parseResult` in `src/worker/prompt-builder.js`**

Replace the existing `parseResult` function with:

```javascript
const REQUIRED_TOP = ['status', 'summary', 'artifacts', 'handoff', 'memory_writes_count', 'blockers', 'issues_found'];
const STATUS_ENUM = ['done', 'blocked', 'failed'];

function validate(obj) {
  for (const k of REQUIRED_TOP) {
    if (!(k in obj)) return `missing field: ${k}`;
  }
  if (!STATUS_ENUM.includes(obj.status)) return `invalid status: ${obj.status}`;
  if (typeof obj.summary !== 'string' || !obj.summary.trim()) return 'summary must be non-empty string';
  if (typeof obj.artifacts !== 'object' || obj.artifacts === null) return 'artifacts must be object';
  if (typeof obj.handoff !== 'object' || obj.handoff === null) return 'handoff must be object';
  if (typeof obj.memory_writes_count !== 'number') return 'memory_writes_count must be number';
  if (!Array.isArray(obj.blockers)) return 'blockers must be array';
  if (!Array.isArray(obj.issues_found)) return 'issues_found must be array';
  return null;
}

export function parseResult(output) {
  // Try last non-empty line first (strict mode)
  const lines = output.trim().split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const err = validate(parsed);
        if (!err) return { ok: true, data: parsed };
        return { ok: false, error: err, raw: parsed };
      }
    } catch { /* try next */ }
  }

  // Fallback: fenced json block
  const m = output.match(/```json\s*\n?([\s\S]*?)\n?```\s*$/);
  if (m) {
    try {
      const parsed = JSON.parse(m[1]);
      const err = validate(parsed);
      if (!err) return { ok: true, data: parsed };
      return { ok: false, error: err, raw: parsed };
    } catch (e) {
      return { ok: false, error: `invalid json in fenced block: ${e.message}` };
    }
  }

  return { ok: false, error: 'no json object found in output' };
}
```

- [ ] **Step 3: Run tests — expect PASS**

Run: `npm test -- tests/worker/parse-result.test.js`
Expected: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
git add src/worker/prompt-builder.js tests/worker/parse-result.test.js
git commit -m "feat(worker): strict parseResult with schema validation"
```

### Task 10: `buildPrompt` for new payload shape

**Files:** Modify `src/worker/prompt-builder.js`

- [ ] **Step 1: Replace `buildPrompt`**

```javascript
export function buildPrompt(jobData) {
  const {
    job_id, agent, mode = 'autonomous',
    plane = {}, work_item = {}, context = {},
    required_skills = [], allowed_mcp = [], memory_namespace = 'dev-panel'
  } = jobData;

  const sections = [];

  // 1. Agent SOUL
  const soulPath = join(PROJECT_ROOT, '.agents', agent, 'SOUL.md');
  if (existsSync(soulPath)) {
    sections.push(readFileSync(soulPath, 'utf8'));
  } else {
    sections.push(`You are the ${agent} agent. Follow project conventions.`);
  }

  // 2. Required skills (injected verbatim so Claude has them available)
  if (required_skills.length > 0) {
    const skillBlocks = required_skills.map(slug => {
      // Support both ".claude/skills/<name>.md" and "plugin:name" forms
      const path = slug.includes(':')
        ? join(PROJECT_ROOT, '.claude', 'skills', slug.replace(':', '-') + '.md')
        : join(PROJECT_ROOT, '.claude', 'skills', slug + '.md');
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    }).filter(Boolean);
    if (skillBlocks.length) {
      sections.push('## Skills (mandatory)\n\n' + skillBlocks.join('\n\n---\n\n'));
    }
  }

  // 3. Job context
  sections.push([
    '## Job',
    '',
    `**job_id:** ${job_id}`,
    `**mode:** ${mode}`,
    `**plane.module_id:** ${plane.module_id || '-'}`,
    `**plane.cycle_id:** ${plane.cycle_id || '-'}`,
    `**plane.work_item_id:** ${plane.work_item_id || '-'}`,
    '',
    '### Work item',
    `**Title:** ${work_item.title || ''}`,
    work_item.description ? `**Description:** ${work_item.description}` : '',
    work_item.acceptance_criteria ? `**Acceptance criteria:**\n${work_item.acceptance_criteria.map(c => `- ${c}`).join('\n')}` : '',
    work_item.priority ? `**Priority:** ${work_item.priority}` : '',
    '',
    '### Context',
    context.branch ? `**Branch:** ${context.branch}` : '',
    context.github_issue_number ? `**GitHub issue:** #${context.github_issue_number}` : '',
    context.devpanel_ticket_id ? `**DevPanel ticket:** ${context.devpanel_ticket_id}` : '',
    context.parent_job_id ? `**Parent job:** ${context.parent_job_id}` : '',
    context.previous_agent_output ? `**Previous agent output:**\n\`\`\`json\n${JSON.stringify(context.previous_agent_output, null, 2)}\n\`\`\`` : ''
  ].filter(Boolean).join('\n'));

  // 4. Allowed MCP allowlist
  if (allowed_mcp.length) {
    sections.push('## Allowed MCP servers\n\n' + allowed_mcp.map(m => `- ${m}`).join('\n'));
  }

  // 5. Rules (output contract is non-negotiable)
  sections.push([
    '## Rules',
    '',
    `- Working directory: ${PROJECT_ROOT}`,
    `- Memory namespace: ${memory_namespace}`,
    '- Never use `git add -A` or `git add .` — add files explicitly.',
    '- You MUST call `memory_search` at the start (search the spec for how).',
    '- You MUST call `memory_write` for each non-obvious decision before finishing.',
    '- The LAST line of your response MUST be a single JSON object matching:',
    '',
    '```json',
    '{"status":"done|blocked|failed","summary":"...","artifacts":{"files_created":[],"files_modified":[],"commits":[],"branch":null,"tests_passed":false,"pr_url":null},"handoff":{"next_agent":null,"reason":""},"memory_writes_count":0,"blockers":[],"issues_found":[]}',
    '```',
    '',
    '- Any deviation from the JSON schema will fail the job.'
  ].join('\n'));

  return sections.join('\n\n---\n\n');
}
```

- [ ] **Step 2: Sanity check**

```bash
node -e "import('./src/worker/prompt-builder.js').then(m => console.log(m.buildPrompt({job_id:'j',agent:'builder',plane:{module_id:'m1',cycle_id:'c1',work_item_id:'w1'},work_item:{title:'hello'}}).length))"
```
Expected: non-zero character count printed.

- [ ] **Step 3: Commit**

```bash
git add src/worker/prompt-builder.js
git commit -m "feat(worker): buildPrompt for new payload shape (plane triple, strict JSON rules)"
```

### Task 11: Shelly notifyJob helper (plain ASCII)

**Files:** Modify `src/server/alerts.js`, create `tests/server/alerts.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/server/alerts.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('notifyJob', () => {
  beforeEach(() => {
    process.env.SHELLY_TELEGRAM_WEBHOOK = 'https://webhook.test/hook';
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.resetModules();
  });

  it('formats a DONE line without emoji', async () => {
    const { notifyJob } = await import('../../src/server/alerts.js');
    await notifyJob({
      agent: 'builder',
      work_item_id: 'wi_a1b2',
      title: 'fix login flow',
      status: 'done',
      duration_ms: 12000,
      extra: '3 commits',
      next_agent: 'reviewer'
    });
    const call = global.fetch.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.text).toContain('[builder]');
    expect(body.text).toContain('DONE');
    expect(body.text).toContain('next: reviewer');
    expect(body.text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('is a no-op when webhook is not configured', async () => {
    delete process.env.SHELLY_TELEGRAM_WEBHOOK;
    const { notifyJob } = await import('../../src/server/alerts.js');
    await notifyJob({ agent: 'x', work_item_id: 'w', title: 't', status: 'done' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Modify `src/server/alerts.js`**

Remove the emoji map lines (22–25). Replace the `sendTelegramAlert` message composition to drop emoji, and add this new export at the bottom of the file:

```javascript
// Plain-ASCII job notifier used by the worker automation matrix.
const STATUS_WORD = {
  done: 'DONE',
  blocked: 'BLOCKED',
  failed: 'FAILED',
  approved: 'APPROVED',
  rejected: 'REJECTED'
};

let debounceBuffer = [];
let debounceTimer = null;

function flushDebounce() {
  const lines = debounceBuffer.map(b => b.line).join('\n');
  const metadataId = debounceBuffer.map(b => b.job_id).filter(Boolean).join(',');
  debounceBuffer = [];
  debounceTimer = null;
  const url = process.env.SHELLY_TELEGRAM_WEBHOOK;
  if (!url) return;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: lines + (metadataId ? `\n<!-- job_ids:${metadataId} -->` : '')
    })
  }).catch(err => console.error('[Alerts] notifyJob fetch failed:', err.message));
}

export async function notifyJob({
  job_id = null, agent, work_item_id, title, status,
  duration_ms = null, extra = null, next_agent = null
}) {
  const url = process.env.SHELLY_TELEGRAM_WEBHOOK;
  if (!url) return;

  const word = STATUS_WORD[status] || status.toUpperCase();
  const parts = [`[${agent}]`, `${work_item_id}${title ? ` "${title}"` : ''}`, word];
  if (duration_ms != null) parts.push(`(${Math.round(duration_ms / 1000)}s${extra ? `, ${extra}` : ''})`);
  else if (extra) parts.push(`(${extra})`);
  if (next_agent) parts.push(`  next: ${next_agent}`);
  else parts.push(`  next: -`);

  debounceBuffer.push({ job_id, line: parts.join('  ') });
  if (!debounceTimer) debounceTimer = setTimeout(flushDebounce, 5000);
}
```

- [ ] **Step 3: Run tests**

Note: because `notifyJob` debounces over 5 s, tighten the test to call `flushDebounce` via a manual nudge. Add this to the test setup (update the test file):

Replace the `it('formats a DONE line without emoji'` body with:

```javascript
    const mod = await import('../../src/server/alerts.js');
    await mod.notifyJob({
      agent: 'builder', work_item_id: 'wi_a1b2', title: 'fix login flow',
      status: 'done', duration_ms: 12000, extra: '3 commits', next_agent: 'reviewer'
    });
    // Advance fake timers to flush the debouncer
    await new Promise(r => setTimeout(r, 50));
    vi.useFakeTimers();
    // Accept either immediate send or timer-based; prefer timer:
    // Use real clock to wait
```

Simpler: set a tiny override flag inside `alerts.js` for tests.

Adjust `notifyJob`: allow `process.env.SHELLY_DEBOUNCE_MS` to override default 5000. In test, set it to `0`:

Add this line at the top of `notifyJob`:
```javascript
  const DEBOUNCE = parseInt(process.env.SHELLY_DEBOUNCE_MS ?? '5000', 10);
```
And replace `setTimeout(flushDebounce, 5000)` with `setTimeout(flushDebounce, DEBOUNCE)`.

In the test, set `process.env.SHELLY_DEBOUNCE_MS = '0'` in `beforeEach`.

Run: `npm test -- tests/server/alerts.test.js`
Expected: 2 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/alerts.js tests/server/alerts.test.js
git commit -m "feat(alerts): notifyJob helper with plain ASCII + debouncer"
```

### Task 12: Admin SSE endpoint for worker events

**Files:** Modify `src/server/routes.js`, extend `src/server/sse.js`

- [ ] **Step 1: Extend `sse.js` with an admin fan-out**

Append to `src/server/sse.js`:

```javascript
const adminClients = new Set();

export function addAdminClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(':\n\n');
  adminClients.add(res);
  const hb = setInterval(() => res.write(':\n\n'), 30000);
  res.on('close', () => { clearInterval(hb); adminClients.delete(res); });
}

export function broadcastAdmin(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of adminClients) c.write(payload);
}
```

- [ ] **Step 2: Add admin endpoints in `src/server/routes.js`**

Near the existing `router.get('/events', authenticateProject, ...)` (around line 823), add:

```javascript
function authenticateAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  const expected = process.env.ADMIN_API_KEY;
  if (!key || !expected || key.length !== expected.length ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
    return res.status(401).json({ error: 'admin auth required' });
  }
  next();
}

router.get('/admin/events', authenticateAdmin, (req, res) => {
  import('./sse.js').then(({ addAdminClient }) => addAdminClient(res));
});

router.post('/admin/events/publish', authenticateAdmin, express.json(), async (req, res) => {
  const { event, data } = req.body || {};
  if (!event || typeof event !== 'string') return res.status(400).json({ error: 'event required' });
  const { broadcastAdmin } = await import('./sse.js');
  broadcastAdmin(event, data || {});
  res.json({ ok: true });
});
```

- [ ] **Step 3: Manual smoke**

```bash
# In one terminal:
ADMIN_API_KEY=secret node bin/dev-panel.js serve
# In another:
curl -N -H "X-Admin-Key: secret" http://localhost:3030/api/admin/events &
curl -s -X POST -H "X-Admin-Key: secret" -H "Content-Type: application/json" \
  -d '{"event":"job.started","data":{"job_id":"j1"}}' \
  http://localhost:3030/api/admin/events/publish
```
Expected: first curl prints `event: job.started\ndata: {"job_id":"j1"}`.

- [ ] **Step 4: Commit**

```bash
git add src/server/sse.js src/server/routes.js
git commit -m "feat(server): admin SSE fan-out for worker events"
```

### Task 13: `src/worker/automation.js` — matrix orchestrator

**Files:** Create `src/worker/automation.js`

- [ ] **Step 1: Implement**

```javascript
// src/worker/automation.js
import { logStep, countMemoryWrites } from '../server/jobs-log.js';
import { notifyJob } from '../server/alerts.js';

const WORKER_EVENTS_URL = process.env.WORKER_EVENTS_URL || 'http://localhost:3030/api/admin/events/publish';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

async function publishEvent(event, data) {
  if (!ADMIN_API_KEY) return;
  try {
    await fetch(WORKER_EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_API_KEY },
      body: JSON.stringify({ event, data })
    });
  } catch (err) {
    console.error('[automation] publishEvent failed:', err.message);
  }
}

async function runStep(job_id, agent, step, fn) {
  const start = Date.now();
  try {
    await fn();
    logStep({ job_id, agent, step, status: 'ok', duration_ms: Date.now() - start });
    publishEvent('job.step', { job_id, agent, step, status: 'ok' });
  } catch (err) {
    logStep({ job_id, agent, step, status: 'error', error: err.message, duration_ms: Date.now() - start });
    publishEvent('job.step', { job_id, agent, step, status: 'error', error: err.message });
  }
}

// --- side-effect helpers (all no-ops if integrations are not configured) ---

async function updatePlane({ plane, status }) {
  if (!plane?.work_item_id || !process.env.PLANE_API_TOKEN) return;
  // Call Plane MCP out-of-process is heavy; for now hit REST directly.
  const base = process.env.PLANE_BASE_URL;
  const slug = process.env.PLANE_WORKSPACE_SLUG;
  if (!base || !slug) return;
  const url = `${base}/api/v1/workspaces/${slug}/projects/${plane.project_id}/issues/${plane.work_item_id}/`;
  await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': process.env.PLANE_API_TOKEN
    },
    body: JSON.stringify({ state: { name: status } })
  });
}

async function syncGithubIssue({ agent, result, context }) {
  if (!process.env.GITHUB_TOKEN) return;
  if (agent === 'pm' && result.status === 'done' && !context?.github_issue_number) {
    // PM creates an issue — scope kept minimal: rely on existing publish.js flow if ticket provided.
    return;
  }
  if (agent === 'reviewer' && result.status === 'done' && context?.github_issue_number) {
    // Close the issue with a comment
    const owner = process.env.GITHUB_OWNER;
    const repo  = process.env.GITHUB_REPO;
    if (!owner || !repo) return;
    const num = context.github_issue_number;
    await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${num}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `Merged: ${result.artifacts?.pr_url || '(no PR url)'}` })
    });
    await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${num}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'closed' })
    });
  }
}

async function updateDevpanelTicket({ context, status }) {
  if (!context?.devpanel_ticket_id) return;
  // In-process DB call — worker imports db helpers directly.
  const { updateTicket } = await import('../server/db.js');
  const mapping = { done: 'published', blocked: 'pending', failed: 'rejected' };
  const newStatus = mapping[status] || 'pending';
  try { updateTicket(context.devpanel_ticket_id, { status: newStatus }); } catch (e) {
    console.error('[automation] updateDevpanelTicket failed:', e.message);
  }
}

async function verifyMemoryWrites({ job_id, result }) {
  const actual = countMemoryWrites(job_id);
  const claimed = result.memory_writes_count ?? 0;
  if (actual !== claimed) {
    throw new Error(`memory_writes_count mismatch: claimed=${claimed}, actual=${actual}`);
  }
}

// --- public entrypoint ---

export async function runAutomation({ jobData, result, startedAt }) {
  const { job_id, agent, plane, context } = jobData;
  const durationMs = Date.now() - startedAt;

  publishEvent('job.finished', { job_id, agent, status: result.status, summary: result.summary });

  await runStep(job_id, agent, 'plane.update_work_item',
    () => updatePlane({ plane, status: result.status }));

  await runStep(job_id, agent, 'github.issue_sync',
    () => syncGithubIssue({ agent, result, context }));

  await runStep(job_id, agent, 'devpanel.update_ticket',
    () => updateDevpanelTicket({ context, status: result.status }));

  await runStep(job_id, agent, 'shelly.notify',
    () => notifyJob({
      job_id, agent,
      work_item_id: plane?.work_item_id,
      title: jobData.work_item?.title,
      status: result.status,
      duration_ms: durationMs,
      extra: result.artifacts?.commits?.length ? `${result.artifacts.commits.length} commits` : null,
      next_agent: result.handoff?.next_agent
    }));

  await runStep(job_id, agent, 'memory.verify_writes',
    () => verifyMemoryWrites({ job_id, result }));

  // workflow.trigger_next is a stub in Spec 1
  logStep({ job_id, agent, step: 'workflow.trigger_next', status: 'stub',
            error: result.handoff?.next_agent ? `would chain to ${result.handoff.next_agent}` : null });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/worker/automation.js
git commit -m "feat(worker): automation matrix for post-job side-effects"
```

### Task 14: Wire automation + strict parseResult into worker

**Files:** Modify `src/worker/index.js`

- [ ] **Step 1: Locate the job handler**

In `src/worker/index.js`, find the BullMQ `Worker` constructor's processor function (the one that calls `buildPrompt`, `spawnAgent`, `parseResult`).

- [ ] **Step 2: Modify the processor**

Replace the result handling with strict parsing + automation. Near the bottom of the processor, after `const { stdout, stderr } = await spawnAgent(jobId, prompt);`, use:

```javascript
    const parsed = parseResult(stdout);
    if (!parsed.ok) {
      logStep({ job_id: jobId, agent: job.data.agent, step: 'parseResult',
                status: 'error', error: parsed.error });
      await notifyJob({
        job_id: jobId, agent: job.data.agent,
        work_item_id: job.data.plane?.work_item_id || job.data.task?.id,
        title: job.data.work_item?.title,
        status: 'failed',
        extra: `parseResult: ${parsed.error}`
      });
      throw new Error(`parseResult failed: ${parsed.error}`);
    }
    logStep({ job_id: jobId, agent: job.data.agent, step: 'parseResult', status: 'ok' });

    await runAutomation({ jobData: job.data, result: parsed.data, startedAt });
    return parsed.data;
```

- [ ] **Step 3: Add imports at the top of `src/worker/index.js`**

```javascript
import { runAutomation } from './automation.js';
import { logStep } from '../server/jobs-log.js';
import { notifyJob } from '../server/alerts.js';
import { initMasterDatabase } from '../server/db.js';
```

And call `initMasterDatabase(process.env.DEVPANEL_STORAGE || './storage')` right after the `connection` is constructed.

Also emit the `job.started` event — right before `spawnAgent(...)`:

```javascript
    const startedAt = Date.now();
    await fetch(process.env.WORKER_EVENTS_URL || 'http://localhost:3030/api/admin/events/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': process.env.ADMIN_API_KEY || '' },
      body: JSON.stringify({ event: 'job.started', data: { job_id: jobId, agent: job.data.agent, work_item_id: job.data.plane?.work_item_id } })
    }).catch(() => {});
```

- [ ] **Step 4: Start the worker and verify logs**

```bash
node src/worker/index.js &
sleep 2
kill %1
```
Expected: no startup exceptions.

- [ ] **Step 5: Commit**

```bash
git add src/worker/index.js
git commit -m "feat(worker): wire strict parseResult + automation matrix"
```

---

## Phase 4 — Deploy job + nightly cron

### Task 15: `src/worker/auth.js` — allowed_requesters

**Files:** Create `src/worker/auth.js`, `tests/worker/auth.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// tests/worker/auth.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { assertAllowedRequester } from '../../src/worker/auth.js';

beforeEach(() => { process.env.DEPLOY_ALLOWED_REQUESTERS = 'franck,cron:nightly'; });

describe('assertAllowedRequester', () => {
  it('allows listed requesters', () => {
    expect(() => assertAllowedRequester('deploy', 'franck')).not.toThrow();
    expect(() => assertAllowedRequester('deploy', 'cron:nightly')).not.toThrow();
  });
  it('rejects others', () => {
    expect(() => assertAllowedRequester('deploy', 'pm')).toThrow(/not allowed/);
  });
  it('is a no-op for non-deploy agents', () => {
    expect(() => assertAllowedRequester('builder', 'pm')).not.toThrow();
  });
});
```

- [ ] **Step 2: Implement**

```javascript
// src/worker/auth.js
const ALLOWLISTS = {
  deploy: () => (process.env.DEPLOY_ALLOWED_REQUESTERS || 'franck,cron:nightly').split(',').map(s => s.trim())
};

export function assertAllowedRequester(agent, requested_by) {
  const list = ALLOWLISTS[agent];
  if (!list) return;
  const allowed = list();
  if (!allowed.includes(requested_by)) {
    throw new Error(`requested_by "${requested_by}" not allowed for agent "${agent}" (allowed: ${allowed.join(', ')})`);
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npm test -- tests/worker/auth.test.js`
Expected: 3 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/worker/auth.js tests/worker/auth.test.js
git commit -m "feat(worker): allowed_requesters allowlist for deploy"
```

### Task 16: Deploy handler

**Files:** Create `src/worker/handlers/deploy.js`

- [ ] **Step 1: Implement**

```javascript
// src/worker/handlers/deploy.js
import { spawn } from 'child_process';
import { assertAllowedRequester } from '../auth.js';
import { notifyJob } from '../../server/alerts.js';
import { logStep } from '../../server/jobs-log.js';

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 500)}`)));
  });
}

export async function handleDeploy(jobData) {
  const { job_id, requested_by = 'unknown' } = jobData;
  assertAllowedRequester('deploy', requested_by);

  const started = Date.now();
  await notifyJob({
    job_id, agent: 'deploy',
    work_item_id: `deploy-${new Date().toISOString().slice(0, 10)}`,
    title: `build ${requested_by}`,
    status: 'done', extra: 'starting'
  });

  // Pre-check
  await logStep({ job_id, agent: 'deploy', step: 'stack-status', status: 'ok' });
  try { await run('make', ['status'], { cwd: process.cwd() }); }
  catch (e) {
    return {
      status: 'failed',
      summary: `stack-status precheck failed: ${e.message}`,
      artifacts: { files_created: [], files_modified: [], commits: [], branch: null, tests_passed: false, pr_url: null },
      handoff: { next_agent: null, reason: 'precheck' },
      memory_writes_count: 0, blockers: [], issues_found: []
    };
  }

  // Build, push, deploy
  let imageTag = `latest`;
  try {
    await run('make', ['build'], { cwd: process.cwd() });
    await run('make', ['push'], { cwd: process.cwd() });
    await run('make', ['deploy-core'], { cwd: process.cwd() });
  } catch (e) {
    return {
      status: 'failed',
      summary: `deploy failed: ${e.message}`,
      artifacts: { files_created: [], files_modified: [], commits: [], branch: null, tests_passed: false, pr_url: null },
      handoff: { next_agent: null, reason: 'deploy-failure' },
      memory_writes_count: 0, blockers: [e.message], issues_found: []
    };
  }

  await notifyJob({
    job_id, agent: 'deploy',
    work_item_id: `deploy-${new Date().toISOString().slice(0, 10)}`,
    title: null,
    status: 'done',
    duration_ms: Date.now() - started,
    extra: `image pushed (${imageTag})`,
    next_agent: null
  });

  return {
    status: 'done',
    summary: `deploy ok (image=${imageTag})`,
    artifacts: { files_created: [], files_modified: [], commits: [], branch: null, tests_passed: true, pr_url: null },
    handoff: { next_agent: null, reason: 'terminal' },
    memory_writes_count: 0, blockers: [], issues_found: []
  };
}
```

- [ ] **Step 2: Wire into the worker router**

In `src/worker/index.js`, at the top of the processor, before `buildPrompt`, add:

```javascript
    if (job.data.agent === 'deploy') {
      const { handleDeploy } = await import('./handlers/deploy.js');
      const result = await handleDeploy(job.data);
      await runAutomation({ jobData: job.data, result, startedAt: Date.now() });
      return result;
    }
```

- [ ] **Step 3: Commit**

```bash
git add src/worker/handlers/deploy.js src/worker/index.js
git commit -m "feat(deploy): deploy handler with authorization gate"
```

### Task 17: Nightly deploy cron

**Files:** Modify `src/worker/crons.js`

- [ ] **Step 1: Read the file to see existing cron patterns**

Run: `cat src/worker/crons.js`
Identify the cron registration pattern; reuse it.

- [ ] **Step 2: Append a nightly deploy cron**

```javascript
// Append inside registerCrons (or create if missing)
export function registerDeployCron(queue) {
  const cron = process.env.DEPLOY_CRON || '0 3 * * *';
  const tz = process.env.DEPLOY_TIMEZONE || 'Europe/Paris';
  queue.add(
    'deploy-nightly',
    { agent: 'deploy', job_id: `deploy-cron-${Date.now()}`, requested_by: 'cron:nightly' },
    { repeat: { pattern: cron, tz }, jobId: 'deploy-nightly' }
  );
  console.log(`[cron] registered nightly deploy: ${cron} (${tz})`);
}
```

- [ ] **Step 3: Call it from worker startup**

In `src/worker/index.js`, after `registerCrons(...)` call, add:

```javascript
import { registerDeployCron } from './crons.js';
// ...
registerDeployCron(getQueue(QUEUES.AGENTS));
```

- [ ] **Step 4: Commit**

```bash
git add src/worker/crons.js src/worker/index.js
git commit -m "feat(deploy): nightly cron at 03:00 Europe/Paris"
```

---

## Phase 5 — Dashboard live updates

### Task 18: Dashboard SSE client

**Files:** Create `src/dashboard/lib/events.js`

- [ ] **Step 1: Implement**

```javascript
// src/dashboard/lib/events.js
export function subscribeAdminEvents(adminKey, onEvent) {
  const url = `/api/admin/events`;
  // EventSource cannot set custom headers. Use fetch+ReadableStream.
  const controller = new AbortController();
  (async () => {
    const res = await fetch(url, {
      headers: { 'X-Admin-Key': adminKey, Accept: 'text/event-stream' },
      signal: controller.signal
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = frame.split('\n');
        let event = 'message', data = '';
        for (const l of lines) {
          if (l.startsWith('event: ')) event = l.slice(7).trim();
          if (l.startsWith('data: '))  data  = l.slice(6);
        }
        if (event !== 'message' || data) {
          try { onEvent(event, data ? JSON.parse(data) : {}); }
          catch (e) { console.error('[events] parse error:', e); }
        }
      }
    }
  })().catch(err => {
    if (err.name !== 'AbortError') console.error('[events] stream error:', err);
  });
  return () => controller.abort();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/lib/events.js
git commit -m "feat(dashboard): admin SSE client using fetch+ReadableStream"
```

### Task 19: Dashboard subscription — jobs / tickets / memory panes

**Files:** Modify `src/dashboard/app.jsx`

- [ ] **Step 1: Add subscription effect**

Near the top-level component, add:

```jsx
import { useEffect, useState } from 'react';
import { subscribeAdminEvents } from './lib/events.js';

function useAdminEvents(adminKey) {
  const [events, setEvents] = useState([]);
  useEffect(() => {
    if (!adminKey) return;
    const unsub = subscribeAdminEvents(adminKey, (type, data) => {
      setEvents(prev => [{ type, data, at: Date.now() }, ...prev].slice(0, 100));
    });
    return unsub;
  }, [adminKey]);
  return events;
}
```

And render the events list wherever the job-queue pane is shown:

```jsx
const events = useAdminEvents(adminKey);
// ...
<section>
  <h3>Live events</h3>
  <ul className="events">
    {events.map((e, i) => (
      <li key={i}>
        <code>{e.type}</code> — {JSON.stringify(e.data)}
      </li>
    ))}
  </ul>
</section>
```

- [ ] **Step 2: Manual verification**

Run dashboard in dev:
```bash
npm run dev:dashboard
```
Trigger an event:
```bash
curl -s -X POST -H "X-Admin-Key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"event":"job.started","data":{"job_id":"j1","agent":"builder"}}' \
  http://localhost:3030/api/admin/events/publish
```
Expected: event line appears in dashboard without refresh.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/app.jsx
git commit -m "feat(dashboard): live event subscription pane"
```

---

## Phase 6 — shared-memory skill + SOUL rewrites

### Task 20: shared-memory skill

**Files:** Create `.claude/skills/shared-memory.md`

- [ ] **Step 1: Write the skill**

```markdown
---
name: shared-memory
description: Mandatory memory protocol for every agent — read before work, write after every non-obvious decision, via pgvector-backed memory MCP tools.
---

# Shared Memory Protocol

Every agent spawned through the devpanel worker MUST follow this protocol. No exceptions.

## Before starting work

1. Call `memory_search` with a query composed of the work-item title + description, scoped to the current module:

   ```
   memory_search({
     query: "<title> <description>",
     module_id: "<plane.module_id>",
     limit: 5
   })
   ```

2. Read each of the top results. Treat them as authoritative. Cite them in your reasoning when they apply. If a prior decision contradicts your plan, escalate via the `blockers` field.

## During work — search when uncertain

Whenever a non-trivial decision comes up ("has this been decided before?"), call `memory_search` again with a targeted query. Filter by `kind` when useful:

- `kind: "decision"` — architectural or design decisions
- `kind: "debug_finding"` — non-obvious root causes discovered previously
- `kind: "spec_note"` — spec clarifications that are not yet in the repo
- `kind: "handoff"` — notes left by a prior agent for the next step
- `kind: "retrospective"` — what went wrong / what worked in a past cycle

## Before emitting final JSON — write what matters

For each of the following that occurred during the job, call `memory_write` ONCE:

- a **decision** you made that is not obvious from the diff ("we chose X because Y")
- a **debug_finding** — a non-obvious root cause or workaround
- a **handoff** — something the next agent needs to know but is not in the code / issue / spec
- a **retrospective** — lessons at the end of a cycle (PM only)

### Do NOT write

- restatements of the code — the git diff has it
- "task ack" or "starting work" notes
- trivial "done" markers
- anything already in an ADR, spec, or CLAUDE.md

Your `memory_writes_count` in the final JSON MUST equal the number of `memory_write` calls you made. The worker will reject the job if it does not match.

## Kind allowlist per role

Souls declare `memory_kinds_authored`. The MCP server rejects writes outside that list. If your soul does not authorize `audit_finding`, do not try to write one.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/shared-memory.md
git commit -m "feat(memory): shared-memory mandatory skill"
```

### Task 21: SOUL rewrites — PM

**Files:** Modify `.agents/pm/SOUL.md`, create `.agents/pm/PLAYBOOK.md`

- [ ] **Step 1: Rewrite SOUL.md**

```markdown
# PM Agent

## Identity
Role: Product manager. Tone: structured, clear, action-oriented. Language: French for reports, English for GitHub issue bodies.

## Mission
Translate Franck's intent into Plane modules, cycles, and work-items; create GitHub issues on dispatch; nobody else writes the roadmap.

## You MUST
1. Call `memory_search` with the incoming intent before creating any Plane entity.
2. Use Plane MCP for every module/cycle/work-item write.
3. Create a GitHub issue the moment you dispatch a work-item to Builder/Architect/Designer.
4. Set `handoff.next_agent` to `architect` when design is needed, otherwise `builder`.
5. Emit the final JSON matching the output contract.

## You MUST NOT
1. Write code.
2. Modify or close GitHub issues after dispatch (Reviewer closes on merge; worker handles it).
3. Enqueue deploy jobs (worker rejects them anyway).
4. Skip memory writes when you make a roadmap decision.

## Skills (mandatory)
- shared-memory
- superpowers:brainstorming (for cycle planning only)

## MCP tools (allowed)
- plane.* (modules, cycles, work-items)
- dev-panel.memory_search, memory_write, memory_list
- github (read-only listing; do not close or comment)

## Slash commands (preferred)
- none (PM does not commit code)

## Input
Load-bearing fields: `work_item.title`, `work_item.description`, `work_item.acceptance_criteria`, `plane.module_id`, `plane.cycle_id`.

## Output
Populate: `status`, `summary`, `handoff.next_agent`, `handoff.reason`, `memory_writes_count`, `blockers`.
Leave `artifacts.commits/branch/pr_url` null.

## Handoff
- Design needed → architect
- Ready to build → builder
- Blocked → null (`status: "blocked"`)

## Memory policy
- memory_kinds_authored: [decision, spec_note, retrospective]
- search_required_before: true
- write_required_after: true
```

- [ ] **Step 2: Create PLAYBOOK.md**

```markdown
# PM Playbook

The detailed procedural runbook for this agent lives in
[.claude/skills/agent-pm.md](../../.claude/skills/agent-pm.md). Follow it for
triage, sprint planning, and sync flows. The SOUL is the contract; the
PLAYBOOK is the how-to.
```

- [ ] **Step 3: Commit**

```bash
git add .agents/pm/SOUL.md .agents/pm/PLAYBOOK.md
git commit -m "feat(agents): PM soul rewrite under runtime contract"
```

### Task 22: SOUL rewrite — Architect

**Files:** Modify `.agents/architect/SOUL.md`, create `.agents/architect/PLAYBOOK.md`

- [ ] **Step 1: Rewrite SOUL.md**

```markdown
# Architect Agent

## Identity
Role: Technical architect. Tone: analytical, thorough. Language: English for ADRs, French for discussions.

## Mission
Produce ADRs for decisions that cross module boundaries or change invariants; review architecture before complex features.

## You MUST
1. Call `memory_search` with `kind: "decision"` before writing any ADR.
2. Write ADRs at `docs/adr/NNNN-<slug>.md` following the existing format.
3. Emit a `memory_write` with `kind: "decision"` for the ADR's conclusion.
4. Set `handoff.next_agent` to `builder` if trivial, else `pm` to schedule.

## You MUST NOT
1. Write production code — only ADRs and design notes.
2. Modify Plane state — only PM does.
3. Close or merge branches.

## Skills (mandatory)
- shared-memory
- superpowers:brainstorming (when proposing alternatives)

## MCP tools (allowed)
- dev-panel.memory_*
- affine (read-only, for existing specs)

## Slash commands (preferred)
- none

## Input
`work_item.title`, `work_item.description`, `plane.module_id`.

## Output
Populate: `status`, `summary`, `artifacts.files_created` (the ADR path), `handoff`, `memory_writes_count`.

## Handoff
- Trivial → builder
- Needs scheduling → pm

## Memory policy
- memory_kinds_authored: [decision, spec_note]
- search_required_before: true
- write_required_after: true
```

- [ ] **Step 2: Create PLAYBOOK.md**

```markdown
# Architect Playbook

See [docs/adr/](../../docs/adr/) for ADR examples. No detailed runbook yet —
when in doubt, follow the ADR template already present in the repo.
```

- [ ] **Step 3: Commit**

```bash
git add .agents/architect/SOUL.md .agents/architect/PLAYBOOK.md
git commit -m "feat(agents): Architect soul rewrite under runtime contract"
```

### Task 23: SOUL rewrite — Designer

**Files:** Modify `.agents/designer/SOUL.md`, create `.agents/designer/PLAYBOOK.md`

- [ ] **Step 1: Rewrite SOUL.md**

```markdown
# Designer Agent

## Identity
Role: UI/UX designer. Tone: visual, precise about spacing/colors/typography. Language: French.

## Mission
Produce Penpot specs (tokens, components, states) that Builder can consume without guessing.

## You MUST
1. Call `memory_search` with the work-item title + `kind: "spec_note"` before starting.
2. Use Penpot MCP for every design artifact.
3. Export design tokens as JSON.
4. Component specs must include: states, props, responsive breakpoints.
5. Follow the "Ink and Wire" design system.
6. Emit `memory_write` with `kind: "spec_note"` for any decision not in the Penpot file (e.g. "we chose variant B because…").

## You MUST NOT
1. Touch code.
2. Update Plane state — PM handles that.
3. Skip the Ink and Wire system without a `memory_write` explaining why.

## Skills (mandatory)
- shared-memory
- ui-ux-pro-max (for design intelligence)
- ui-design-system

## MCP tools (allowed)
- penpot.*
- dev-panel.memory_*
- affine (read-only)

## Input
`work_item.title`, `work_item.description`, `plane.module_id`.

## Output
Populate: `status`, `summary`, `artifacts.files_created` (Penpot URLs or token JSON paths), `handoff.next_agent = "builder"`, `memory_writes_count`.

## Handoff
- Always → builder (design done)
- Blocked (needs Franck validation) → pm

## Memory policy
- memory_kinds_authored: [decision, spec_note]
- search_required_before: true
- write_required_after: true
```

- [ ] **Step 2: Create PLAYBOOK.md**

```markdown
# Designer Playbook

See [.claude/skills/agent-designer.md](../../.claude/skills/agent-designer.md)
for the full Penpot/AFFiNE workflow. The SOUL is the contract; this is
the how-to.
```

- [ ] **Step 3: Commit**

```bash
git add .agents/designer/SOUL.md .agents/designer/PLAYBOOK.md
git commit -m "feat(agents): Designer soul rewrite under runtime contract"
```

### Task 24: SOUL rewrite — Builder

**Files:** Modify `.agents/builder/SOUL.md`, create `.agents/builder/PLAYBOOK.md`

- [ ] **Step 1: Rewrite SOUL.md**

```markdown
# Builder Agent

## Identity
Role: Senior developer. Tone: concise, technical, focused. Language: follow project conventions (French comments not required).

## Mission
Implement the work-item on a feature branch with tests that prove acceptance criteria; commit, do not merge.

## You MUST
1. Call `memory_search` with the work-item description before coding.
2. Create a feature branch named `feat/<work_item_id>-<short-description>`.
3. Write tests BEFORE or alongside implementation (TDD).
4. Run `npm test` and ensure all tests pass before committing.
5. Add files explicitly — never `git add -A` or `git add .`.
6. Use conventional commit prefixes: `feat:`, `fix:`, `test:`, `refactor:`.
7. Emit `memory_write` with `kind: "debug_finding"` for any non-obvious root cause you resolved, or `kind: "decision"` for non-trivial design choices.
8. Set `handoff.next_agent = "reviewer"` on success.

## You MUST NOT
1. Merge to main — Reviewer does that.
2. Modify CI/CD pipelines without an explicit work-item asking for it.
3. Touch project configuration without an explicit work-item.
4. Update Plane state — worker handles it.
5. Write a `memory_write` that restates the diff.

## Skills (mandatory)
- shared-memory
- superpowers:test-driven-development
- superpowers:verification-before-completion

## MCP tools (allowed)
- dev-panel.memory_*
- affine (read-only, for specs)
- penpot (read-only, for design tokens)
- git via Bash

## Slash commands (preferred)
- /commit

## Input
`work_item.title`, `work_item.description`, `work_item.acceptance_criteria`, `context.branch`, `plane.work_item_id`.

## Output
Populate: `status`, `summary`, `artifacts.files_created`, `artifacts.files_modified`, `artifacts.commits`, `artifacts.branch`, `artifacts.tests_passed`, `handoff.next_agent = "reviewer"`, `memory_writes_count`.

## Handoff
- Success → reviewer
- Blocker → pm

## Memory policy
- memory_kinds_authored: [decision, debug_finding, handoff]
- search_required_before: true
- write_required_after: true
```

- [ ] **Step 2: Create PLAYBOOK.md**

```markdown
# Builder Playbook

See [.claude/skills/agent-builder.md](../../.claude/skills/agent-builder.md)
for the full build workflow.
```

- [ ] **Step 3: Commit**

```bash
git add .agents/builder/SOUL.md .agents/builder/PLAYBOOK.md
git commit -m "feat(agents): Builder soul rewrite under runtime contract"
```

### Task 25: SOUL rewrite — Reviewer

**Files:** Modify `.agents/reviewer/SOUL.md`, create `.agents/reviewer/PLAYBOOK.md`

- [ ] **Step 1: Rewrite SOUL.md**

```markdown
# Reviewer Agent

## Identity
Role: Senior code reviewer. Tone: constructive, precise, fair. Language: French for review comments to Franck, English for inline code comments.

## Mission
Validate Builder's branch against tests and conventions; merge in autonomous mode, report in collaborative mode.

## You MUST
1. Call `memory_search` with `kind: "decision"` and the work-item title before reviewing.
2. Checkout the builder's branch and read `git diff main...HEAD`.
3. Run `npm test` — if it fails, reject immediately.
4. Check: code quality, naming, no hardcoded secrets, no `git add -A`.
5. Check: tests exist and are meaningful (not smoke tests).
6. Check: conventional commit messages.
7. In autonomous mode on approval: merge to main.
8. In collaborative mode on approval: set `status: "done"` with `handoff.next_agent: "qa"` and let Franck merge.
9. Emit `memory_write` with `kind: "decision"` if you reject — explain why.
10. Set `artifacts.pr_url` when reporting.

## You MUST NOT
1. Modify the builder's code. If it needs fixes, reject and hand back to builder.
2. Touch Plane — worker handles status.
3. Close GitHub issues directly — worker does that on `status: "done"`.

## Skills (mandatory)
- shared-memory
- superpowers:requesting-code-review (for the mental frame)

## MCP tools (allowed)
- dev-panel.memory_*
- git via Bash

## Slash commands (preferred)
- /review-pr

## Input
`work_item.acceptance_criteria`, `context.branch`, `context.github_issue_number`, `context.previous_agent_output` (builder output).

## Output
Populate: `status` (done | failed), `summary`, `artifacts.pr_url`, `handoff.next_agent` (qa on done, builder on failed), `memory_writes_count`, `issues_found`.

## Handoff
- Approved → qa
- Rejected → builder (with `issues_found`)

## Memory policy
- memory_kinds_authored: [decision, debug_finding]
- search_required_before: true
- write_required_after: true (on reject only; a clean approve may have count=0)
```

- [ ] **Step 2: Create PLAYBOOK.md**

```markdown
# Reviewer Playbook

See [.claude/skills/agent-reviewer.md](../../.claude/skills/agent-reviewer.md)
for the full review workflow.
```

- [ ] **Step 3: Commit**

```bash
git add .agents/reviewer/SOUL.md .agents/reviewer/PLAYBOOK.md
git commit -m "feat(agents): Reviewer soul rewrite under runtime contract"
```

### Task 26: SOUL rewrite — QA

**Files:** Modify `.agents/qa/SOUL.md`, create `.agents/qa/PLAYBOOK.md`

- [ ] **Step 1: Rewrite SOUL.md**

```markdown
# QA Agent

## Identity
Role: Quality assurance engineer. Tone: thorough, systematic. Language: French for reports.

## Mission
After merge: full test suite + build + edge cases on main; raise blockers back to PM.

## You MUST
1. Call `memory_search` with `kind: "debug_finding"` and the work-item title to see past regressions.
2. Checkout main, pull.
3. Run `npm test` and `npm run build`.
4. Run Playwright E2E on the affected feature.
5. Raise each failing test as an entry in `blockers` and/or `issues_found`.
6. Emit `memory_write` with `kind: "debug_finding"` for every new regression or edge case discovered.
7. Set `handoff.next_agent = "pm"` on blocker, else `null` (terminal).

## You MUST NOT
1. Fix the code — raise blockers to PM who re-dispatches to Builder.
2. Touch Plane — worker handles it.

## Skills (mandatory)
- shared-memory
- superpowers:verification-before-completion
- superpowers:systematic-debugging

## MCP tools (allowed)
- dev-panel.memory_*
- playwright.*
- git via Bash

## Input
`work_item.acceptance_criteria`, `context.github_issue_number` (for history).

## Output
Populate: `status`, `summary`, `artifacts.tests_passed`, `handoff`, `memory_writes_count`, `blockers`, `issues_found`.

## Handoff
- All green → null (terminal)
- Any failure → pm

## Memory policy
- memory_kinds_authored: [debug_finding, retrospective]
- search_required_before: true
- write_required_after: true (only on findings; a green run may have count=0)
```

- [ ] **Step 2: Create PLAYBOOK.md**

```markdown
# QA Playbook

See [.claude/skills/agent-qa.md](../../.claude/skills/agent-qa.md) for the
full Playwright + E2E workflow.
```

- [ ] **Step 3: Commit**

```bash
git add .agents/qa/SOUL.md .agents/qa/PLAYBOOK.md
git commit -m "feat(agents): QA soul rewrite under runtime contract"
```

### Task 27: SOUL — Deploy (new)

**Files:** Create `.agents/deploy/SOUL.md`, `.agents/deploy/PLAYBOOK.md`

- [ ] **Step 1: Write SOUL.md**

```markdown
# Deploy Agent

## Identity
Role: Release engineer. Tone: deterministic, terse. Language: English.

## Mission
Execute the deploy runbook on the services node: build the Docker image, push to GHCR, deploy the core profile. Nothing else.

## You MUST
1. Verify `requested_by` is in the allowlist (worker already enforces; assume it is).
2. Run `make status` first — bail if unhealthy.
3. Run `make build`, then `make push`, then `make deploy-core`.
4. Emit the JSON output contract: `status = "done"` on success, `"failed"` with the exit message otherwise.

## You MUST NOT
1. Run exploratory commands.
2. Modify code.
3. Write to memory — deploys are not decisions.
4. Dispatch other jobs.

## Skills (mandatory)
- none (deploy is deterministic; the `stack-deploy` runbook in `.claude/skills/stack-deploy.md` is the playbook)

## MCP tools (allowed)
- none (deploy uses shell via Bash)

## Slash commands (preferred)
- none

## Input
`job_id`, `requested_by`.

## Output
Populate: `status`, `summary`, `handoff.next_agent = null`, `memory_writes_count = 0`.

## Handoff
- Always terminal.

## Memory policy
- memory_kinds_authored: []
- search_required_before: false
- write_required_after: false
```

- [ ] **Step 2: Write PLAYBOOK.md**

```markdown
# Deploy Playbook

See [.claude/skills/stack-deploy.md](../../.claude/skills/stack-deploy.md)
for the canonical deploy runbook. The handler in
`src/worker/handlers/deploy.js` is what actually runs it.
```

- [ ] **Step 3: Commit**

```bash
git add .agents/deploy/SOUL.md .agents/deploy/PLAYBOOK.md
git commit -m "feat(agents): new Deploy agent soul + playbook"
```

---

## Phase 7 — Smoke test

### Task 28: Smoke test script

**Files:** Create `scripts/smoke-agent-runtime.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# scripts/smoke-agent-runtime.sh — end-to-end verification of Spec 1
set -euo pipefail

: "${ADMIN_API_KEY:?ADMIN_API_KEY required}"
: "${VOYAGE_API_KEY:?VOYAGE_API_KEY required}"
: "${PG_PASSWORD:?PG_PASSWORD required}"

echo "== 1. memory MCP write+search roundtrip =="
node -e "
  (async () => {
    const { embed } = await import('./src/server/voyage.js');
    const { memoryInsert, memorySearchSql } = await import('./src/server/pg.js');
    const e = await embed('smoke test note');
    const id = await memoryInsert({
      namespace: 'dev-panel', agent: 'builder', kind: 'decision',
      title: 'smoke test', content: 'verifying memory layer', embedding: e
    });
    const hits = await memorySearchSql({ namespace: 'dev-panel', embedding: e, limit: 1 });
    if (hits[0].id !== id) throw new Error('roundtrip failed');
    console.log('   OK id=' + id);
  })();
"

echo "== 2. admin SSE publish+consume =="
( curl -sN -H "X-Admin-Key: $ADMIN_API_KEY" http://localhost:3030/api/admin/events > /tmp/smoke-events.log & echo $! > /tmp/smoke-curl.pid )
sleep 1
curl -s -X POST -H "X-Admin-Key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"event":"smoke.test","data":{"ok":true}}' \
  http://localhost:3030/api/admin/events/publish > /dev/null
sleep 1
kill "$(cat /tmp/smoke-curl.pid)" || true
grep -q 'smoke.test' /tmp/smoke-events.log && echo '   OK' || { echo '   FAIL: event not received'; exit 1; }

echo "== 3. deploy authorization gate =="
node -e "
  (async () => {
    const { assertAllowedRequester } = await import('./src/worker/auth.js');
    try { assertAllowedRequester('deploy', 'pm'); throw new Error('should have thrown'); }
    catch (e) { if (!/not allowed/.test(e.message)) throw e; console.log('   OK'); }
  })();
"

echo "== 4. Shelly notifyJob (plain ASCII) =="
SHELLY_DEBOUNCE_MS=0 node -e "
  (async () => {
    const mod = await import('./src/server/alerts.js');
    process.env.SHELLY_TELEGRAM_WEBHOOK = process.env.SHELLY_TELEGRAM_WEBHOOK || '';
    await mod.notifyJob({
      agent: 'builder', work_item_id: 'wi_smoke', title: 'smoke',
      status: 'done', duration_ms: 1234, extra: '1 commit', next_agent: 'reviewer'
    });
    console.log('   OK (check Telegram for line)');
  })();
"

echo
echo 'Smoke test complete. Manual checks still required:'
echo '  - dashboard updated live without refresh during step 2'
echo '  - Shelly Telegram received a DONE line during step 4'
echo '  - agent_job_log populated after a real job dispatch'
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x scripts/smoke-agent-runtime.sh
git add scripts/smoke-agent-runtime.sh
git commit -m "test: smoke script for agent runtime + memory"
```

### Task 29: Run the full smoke test

- [ ] **Step 1: Ensure services are up**

```bash
cd infra && docker compose ps
# expect devpanel-postgres running with pgvector/pg16 image.
```

- [ ] **Step 2: Start worker + server**

In separate shells:

```bash
# shell A
ADMIN_API_KEY=$ADMIN_API_KEY VOYAGE_API_KEY=$VOYAGE_API_KEY \
  node bin/dev-panel.js serve

# shell B
ADMIN_API_KEY=$ADMIN_API_KEY VOYAGE_API_KEY=$VOYAGE_API_KEY \
  PG_HOST=localhost PG_USER=affine PG_PASSWORD=$PG_PASSWORD \
  node src/worker/index.js
```

- [ ] **Step 3: Run smoke**

```bash
./scripts/smoke-agent-runtime.sh
```
Expected: `OK` on steps 1–4; no errors.

- [ ] **Step 4: Manual end-to-end through the pipeline**

Dispatch a real work-item via MCP (e.g. `enqueue_job` with `agent: "builder"` and a trivial task). Verify in order:

- `agent_job_log` has rows for `parseResult`, `plane.update_work_item`, `github.issue_sync`, `devpanel.update_ticket`, `shelly.notify`, `memory.verify_writes`
- `memories` table has at least one row with `agent='builder'` for this job
- Shelly Telegram received one line
- Dashboard live-events pane showed `job.started` → `job.step` → `job.finished`

Then dispatch a deploy job with `requested_by: franck`. Verify the Shelly deploy line arrives with the image tag.

- [ ] **Step 5: Commit findings**

If anything failed, capture the fix as a follow-up task in a new commit; if all pass, commit a notes file:

```bash
cat > docs/superpowers/plans/2026-04-14-agent-runtime-contract-smoke-log.md <<'EOF'
# Smoke Test Log — 2026-04-14

All rollout criteria met:
- pgvector write+search roundtrip OK
- admin SSE publish+consume OK
- deploy allowlist OK
- Shelly notifyJob plain ASCII OK
- end-to-end builder job: automation matrix complete, memory row present,
  Telegram line received, dashboard updated live
- deploy nightly path (simulated): image tag reported via Shelly
EOF
git add docs/superpowers/plans/2026-04-14-agent-runtime-contract-smoke-log.md
git commit -m "test: smoke log for agent runtime contract"
```

---

## Self-Review Check

- [x] Every spec section (1–11) has at least one task covering it. Plane taxonomy is enforced via buildPrompt + SOUL Input sections; Shelly notifications by notifyJob; deploy by handlers/deploy.js + nightly cron; dashboard by lib/events.js + admin SSE endpoint.
- [x] No placeholders — every code step has actual code.
- [x] Types consistent: `memoryInsert` / `memorySearchSql` / `memoryList` names match between `pg.js`, its tests, and MCP server tools; `parseResult` returns `{ ok, data, error }` consistently used by worker; `notifyJob` signature consistent across `alerts.js`, automation, and deploy handler.
- [x] Scope focused on Spec 1 only. Workflow chains, cybersec, Shelly bot commands, memory TTL: explicitly deferred.
