# Workflow Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Spec 1 `workflow.trigger_next` stub with a hybrid declarative workflow engine that chains agents through YAML-defined pipelines, supports re-entrant replan loops, and drives a Plane/Telegram-visible Pipelines pane.

**Architecture:** Three YAML workflow files loaded at worker boot; per-`(work_item_id, workflow_name)` instance state in agents-node SQLite with a unique partial index; engine module `src/worker/engine.js` called from `runAutomation` step 7; dispatch entry points via MCP + CLI; dashboard SSE updates.

**Tech Stack:** Node.js ESM, better-sqlite3, BullMQ, vitest (+ tmpdir fixtures), `yaml` package for YAML parsing, existing SSE fan-out in `src/server/sse.js`.

**Spec:** `docs/superpowers/specs/2026-04-14-workflow-engine-design.md`.

**Plane tracking:** module `Workflow Engine (Spec 2)` id `dec8581c-2cee-49d4-8244-0c8fc9b5b078` on project `devpanl` (`d2522fed-e3f2-4eeb-9077-6445261752c1`), cycle `Sprint 1 — Agents Pipeline & Dashboard Polish`. Tasks below map 1:1 to Plane work-items T01–T09.

---

## File Map

**Create:**
- `src/server/workflow-instances.js` — CRUD for `workflow_instances` SQLite table
- `src/worker/engine.js` — YAML loader + `triggerNext` evaluator
- `src/worker/predicates.js` — registry of named predicate functions
- `src/worker/workflows/work-item.yaml`
- `src/worker/workflows/cycle-audit.yaml`
- `src/worker/workflows/replan.yaml`
- `src/worker/dispatch.js` — `enqueueWorkflowStart` shared helper
- `src/dashboard/components/PipelinesPane.jsx` — live pipelines view
- `src/dashboard/lib/workflow-events.js` — SSE subscription for `workflow.*` events
- `infra/migrations/002-workflow-instances.sql` — idempotent SQL for prod SQLite
- `scripts/smoke-workflow-engine.sh` — end-to-end smoke
- `tests/server/workflow-instances.test.js`
- `tests/worker/engine-loader.test.js`
- `tests/worker/engine-transitions.test.js`
- `tests/worker/predicates.test.js`
- `tests/worker/dispatch.test.js`

**Modify:**
- `src/server/db.js` — add `workflow_instances` CREATE to `initMasterDatabase`
- `src/worker/automation.js` — replace the stub at line 116 with a real `triggerNext` call
- `src/worker/index.js` — remove the legacy builder→reviewer chain in `worker.on('completed')` (lines 208-240; the engine owns chaining now)
- `src/mcp/server.js` — add `plane.dispatch_work_item`, `plane.close_cycle`, `devpanel_workflow_dispatch` MCP tools
- `bin/dev-panel.js` — add `workflow dispatch <work_item_id>` CLI subcommand
- `src/server/routes.js` — add `GET /api/admin/workflows/instances` and `/:id` endpoints
- `src/dashboard/App.jsx` (or the Queues view) — mount `PipelinesPane`
- `.agents/reviewer/SOUL.md` — declare `handoff.retreat_allowed: [builder]`
- `.agents/qa/SOUL.md` — declare `handoff.retreat_allowed: [pm]`
- `.agents/pm/SOUL.md` — add "Replan mode" section
- `package.json` — add `yaml` dep

---

## Task 0: Bootstrap — worktree + dep

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Create isolated worktree**

```bash
git worktree add .worktrees/workflow-engine -b feat/workflow-engine
cd .worktrees/workflow-engine
```

Expected: new branch `feat/workflow-engine` off `main`, ready for Spec 2 work.

- [ ] **Step 2: Install YAML parser**

```bash
npm install yaml
```

Expected: `yaml` added to `dependencies` in `package.json` (latest 2.x).

- [ ] **Step 3: Verify test toolchain green**

```bash
npm test
```

Expected: existing 15 tests pass (Spec 1 coverage), 3 skipped. Any failure means the worktree bootstrap missed something — fix before proceeding.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(spec2): add yaml parser dep for workflow engine"
```

---

## Task 1 (T01): `workflow_instances` SQLite schema + CRUD module

**Files:**
- Modify: `src/server/db.js:57` (add CREATE TABLE block inside `initMasterDatabase`)
- Create: `src/server/workflow-instances.js`
- Create: `infra/migrations/002-workflow-instances.sql`
- Create: `tests/server/workflow-instances.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/server/workflow-instances.test.js`:

```js
// tests/server/workflow-instances.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase } from '../../src/server/db.js';
import {
  createInstance, loadInstance, updateInstance,
  listActive, listByCycle
} from '../../src/server/workflow-instances.js';

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-wi-'));
  initMasterDatabase(dir);
});

describe('workflow-instances', () => {
  it('creates an instance and loads it by (work_item_id, workflow_name)', () => {
    const id = createInstance({
      work_item_id: 'wi-1', workflow_name: 'work-item',
      current_step: 'builder', module_id: 'mod-1', cycle_id: 'cyc-1'
    });
    const row = loadInstance({ work_item_id: 'wi-1', workflow_name: 'work-item' });
    expect(row.id).toBe(id);
    expect(row.status).toBe('running');
    expect(row.revision).toBe(1);
    expect(row.current_step).toBe('builder');
  });

  it('rejects a duplicate active instance on the same (work_item, workflow)', () => {
    createInstance({ work_item_id: 'wi-2', workflow_name: 'work-item', current_step: 'builder' });
    expect(() =>
      createInstance({ work_item_id: 'wi-2', workflow_name: 'work-item', current_step: 'builder' })
    ).toThrow(/UNIQUE/);
  });

  it('allows a new instance once the prior one is terminal', () => {
    createInstance({ work_item_id: 'wi-3', workflow_name: 'work-item', current_step: 'builder' });
    updateInstance({ work_item_id: 'wi-3', workflow_name: 'work-item' },
                   { status: 'done' });
    const id2 = createInstance({ work_item_id: 'wi-3', workflow_name: 'work-item', current_step: 'builder' });
    expect(id2).toBeGreaterThan(0);
  });

  it('updates current_step, revision, status, last_event_at', () => {
    createInstance({ work_item_id: 'wi-4', workflow_name: 'work-item', current_step: 'builder' });
    updateInstance({ work_item_id: 'wi-4', workflow_name: 'work-item' },
                   { current_step: 'reviewer', revision: 2 });
    const row = loadInstance({ work_item_id: 'wi-4', workflow_name: 'work-item' });
    expect(row.current_step).toBe('reviewer');
    expect(row.revision).toBe(2);
    expect(row.last_event_at).toBeGreaterThanOrEqual(row.started_at);
  });

  it('lists active instances', () => {
    const rows = listActive();
    const ids = rows.map(r => r.work_item_id);
    expect(ids).toContain('wi-1');
    expect(ids).not.toContain('wi-3'); // wi-3 was flipped to done before wi-3 recreate
  });

  it('lists instances by cycle_id', () => {
    createInstance({ work_item_id: 'wi-c', workflow_name: 'work-item', current_step: 'builder', cycle_id: 'cyc-X' });
    const rows = listByCycle('cyc-X');
    expect(rows.some(r => r.work_item_id === 'wi-c')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/server/workflow-instances.test.js
```

Expected: FAIL with "Failed to resolve import '../../src/server/workflow-instances.js'".

- [ ] **Step 3: Add table definition to `initMasterDatabase`**

Open `src/server/db.js`. Inside the `masterDb.exec(\`...\`)` block (after the `agent_memory_writes` table, before the closing backtick at line 57), append:

```sql
CREATE TABLE IF NOT EXISTS workflow_instances (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id    TEXT NOT NULL,
  workflow_name   TEXT NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 1,
  current_step    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running',
  module_id       TEXT,
  cycle_id        TEXT,
  started_at      INTEGER NOT NULL,
  last_event_at   INTEGER NOT NULL,
  exhausted_at    INTEGER,
  last_job_id     TEXT,
  metadata        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wi_workflow_active
  ON workflow_instances(work_item_id, workflow_name)
  WHERE status IN ('running', 'awaiting_approval');
CREATE INDEX IF NOT EXISTS idx_wi_status ON workflow_instances(status);
CREATE INDEX IF NOT EXISTS idx_wi_cycle  ON workflow_instances(cycle_id);
```

- [ ] **Step 4: Create `src/server/workflow-instances.js`**

```js
// src/server/workflow-instances.js
import { getMasterDatabase } from './db.js';

export function createInstance({
  work_item_id, workflow_name, current_step,
  module_id = null, cycle_id = null,
  metadata = null
}) {
  const db = getMasterDatabase();
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO workflow_instances
       (work_item_id, workflow_name, revision, current_step, status,
        module_id, cycle_id, started_at, last_event_at, metadata)
     VALUES (?, ?, 1, ?, 'running', ?, ?, ?, ?, ?)`
  ).run(work_item_id, workflow_name, current_step,
        module_id, cycle_id, now, now,
        metadata ? JSON.stringify(metadata) : null);
  return info.lastInsertRowid;
}

export function loadInstance({ work_item_id, workflow_name }) {
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT * FROM workflow_instances
      WHERE work_item_id = ? AND workflow_name = ?
      ORDER BY id DESC LIMIT 1`
  ).get(work_item_id, workflow_name);
}

export function loadInstanceById(id) {
  const db = getMasterDatabase();
  return db.prepare(`SELECT * FROM workflow_instances WHERE id = ?`).get(id);
}

export function updateInstance({ work_item_id, workflow_name }, patch) {
  const db = getMasterDatabase();
  const current = loadInstance({ work_item_id, workflow_name });
  if (!current) throw new Error(`no instance for (${work_item_id}, ${workflow_name})`);
  const fields = { ...current, ...patch, last_event_at: Date.now() };
  if (patch.status === 'exhausted') fields.exhausted_at = Date.now();
  db.prepare(
    `UPDATE workflow_instances
        SET revision=?, current_step=?, status=?, last_event_at=?,
            exhausted_at=?, last_job_id=?, metadata=?
      WHERE id=?`
  ).run(fields.revision, fields.current_step, fields.status, fields.last_event_at,
        fields.exhausted_at || null, fields.last_job_id || null,
        typeof fields.metadata === 'string' ? fields.metadata :
          (fields.metadata ? JSON.stringify(fields.metadata) : null),
        current.id);
  return loadInstanceById(current.id);
}

export function listActive() {
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT * FROM workflow_instances
      WHERE status IN ('running', 'awaiting_approval')
      ORDER BY last_event_at DESC`
  ).all();
}

export function listByCycle(cycle_id) {
  const db = getMasterDatabase();
  return db.prepare(
    `SELECT * FROM workflow_instances WHERE cycle_id = ? ORDER BY last_event_at DESC`
  ).all(cycle_id);
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- tests/server/workflow-instances.test.js
```

Expected: PASS all 6 assertions.

- [ ] **Step 6: Create prod migration file**

Create `infra/migrations/002-workflow-instances.sql` with the exact same SQL from Step 3 (the CREATE TABLE + 3 indexes). This file is applied by hand on the agents-node SQLite during rollout; the in-code `CREATE IF NOT EXISTS` in `db.js` is what fresh worktrees use.

- [ ] **Step 7: Commit**

```bash
git add src/server/db.js src/server/workflow-instances.js \
        tests/server/workflow-instances.test.js infra/migrations/002-workflow-instances.sql
git commit -m "feat(workflow): add workflow_instances table and CRUD module"
```

---

## Task 2 (T02): Workflow YAML loader + predicate registry + 3 workflow files

**Files:**
- Create: `src/worker/predicates.js`
- Create: `src/worker/engine.js` (loader half only; `triggerNext` comes in Task 3)
- Create: `src/worker/workflows/work-item.yaml`
- Create: `src/worker/workflows/cycle-audit.yaml`
- Create: `src/worker/workflows/replan.yaml`
- Create: `tests/worker/engine-loader.test.js`
- Create: `tests/worker/predicates.test.js`

- [ ] **Step 1: Write the predicate registry test**

Create `tests/worker/predicates.test.js`:

```js
// tests/worker/predicates.test.js
import { describe, it, expect } from 'vitest';
import { predicates } from '../../src/worker/predicates.js';

describe('predicates', () => {
  it('reviewer_rejected_pr — true on p1+ issue', () => {
    expect(predicates.reviewer_rejected_pr({
      issues_found: [{ severity: 'p1', title: 'x' }]
    })).toBe(true);
    expect(predicates.reviewer_rejected_pr({
      issues_found: [{ severity: 'p3', title: 'nit' }]
    })).toBe(false);
    expect(predicates.reviewer_rejected_pr({ issues_found: [] })).toBe(false);
    expect(predicates.reviewer_rejected_pr({})).toBe(false);
  });
  it('qa_infra_only — true iff every blocker.kind is "infra"', () => {
    expect(predicates.qa_infra_only({
      blockers: [{ kind: 'infra' }, { kind: 'infra' }]
    })).toBe(true);
    expect(predicates.qa_infra_only({
      blockers: [{ kind: 'infra' }, { kind: 'code' }]
    })).toBe(false);
    expect(predicates.qa_infra_only({ blockers: [] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- tests/worker/predicates.test.js
```

Expected: FAIL — module not resolvable.

- [ ] **Step 3: Implement the predicate registry**

Create `src/worker/predicates.js`:

```js
// src/worker/predicates.js
// Each predicate is a pure function (result, jobData) => boolean.
// Referenced by name from workflow YAML `when:` clauses.

const P0_P1 = new Set(['p0', 'p1']);

export const predicates = {
  reviewer_rejected_pr(result) {
    const issues = result?.issues_found || [];
    return issues.some(i => P0_P1.has(i?.severity));
  },
  qa_infra_only(result) {
    const blockers = result?.blockers || [];
    if (blockers.length === 0) return false;
    return blockers.every(b => b?.kind === 'infra');
  }
};
```

- [ ] **Step 4: Run predicate test — expect PASS**

```bash
npm test -- tests/worker/predicates.test.js
```

Expected: PASS both cases.

- [ ] **Step 5: Author the three workflow YAMLs**

Create `src/worker/workflows/work-item.yaml`:

```yaml
name: work-item
description: Standard work-item pipeline — build, review, QA.
max_revisions: 3
on_exhaustion: block

steps:
  - agent: builder
    on:
      done:     { next: reviewer }
      blocked:  { next: pm, workflow: replan }
      failed:   { terminal: true }

  - agent: reviewer
    retreat_allowed: [builder]
    on:
      done:     { next: qa }
      blocked:  { next: pm, workflow: replan }
      failed:   { next: builder, when: reviewer_rejected_pr }

  - agent: qa
    retreat_allowed: [pm]
    on:
      done:     { terminal: true }
      failed:   { next: pm, workflow: replan }
      blocked:  { next: pm, workflow: replan }
```

Create `src/worker/workflows/cycle-audit.yaml`:

```yaml
name: cycle-audit
description: Cycle-end cybersecurity audit (agent lands in Spec 3).
max_revisions: 1
on_exhaustion: block

steps:
  - agent: audit
    on:
      done:     { terminal: true }
      failed:   { next: pm, workflow: replan }
      blocked:  { next: pm, workflow: replan }
```

Create `src/worker/workflows/replan.yaml`:

```yaml
name: replan
description: PM re-plans a failed workflow revision.
max_revisions: 1
on_exhaustion: block

steps:
  - agent: pm
    on:
      done:     { terminal: true }
      blocked:  { terminal: true }
      failed:   { terminal: true }
```

- [ ] **Step 6: Write the loader test**

Create `tests/worker/engine-loader.test.js`:

```js
// tests/worker/engine-loader.test.js
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadWorkflows } from '../../src/worker/engine.js';

describe('loadWorkflows', () => {
  it('loads the three shipped workflow YAMLs', () => {
    const flows = loadWorkflows();
    expect(Object.keys(flows).sort()).toEqual(['cycle-audit', 'replan', 'work-item']);
    expect(flows['work-item'].max_revisions).toBe(3);
    expect(flows['work-item'].steps.map(s => s.agent)).toEqual(['builder', 'reviewer', 'qa']);
  });

  it('rejects a YAML file that references an unknown predicate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-yaml-'));
    writeFileSync(join(dir, 'bad.yaml'),
      `name: bad\nmax_revisions: 1\non_exhaustion: block\nsteps:\n` +
      `  - agent: builder\n    on:\n      done: { next: reviewer, when: no_such_predicate }\n`);
    expect(() => loadWorkflows(dir)).toThrow(/unknown predicate: no_such_predicate/);
  });

  it('rejects malformed YAML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-yaml-'));
    writeFileSync(join(dir, 'bad.yaml'), 'not: [valid: yaml');
    expect(() => loadWorkflows(dir)).toThrow();
  });
});
```

- [ ] **Step 7: Run the loader test — expect FAIL**

```bash
npm test -- tests/worker/engine-loader.test.js
```

Expected: FAIL — `loadWorkflows` not exported.

- [ ] **Step 8: Implement the loader in `src/worker/engine.js`**

```js
// src/worker/engine.js
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYAML } from 'yaml';
import { predicates } from './predicates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKFLOW_DIR = join(__dirname, 'workflows');

export function loadWorkflows(dir = DEFAULT_WORKFLOW_DIR) {
  const files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const flows = {};
  const usedPredicates = new Set();

  for (const f of files) {
    const raw = readFileSync(join(dir, f), 'utf8');
    const doc = parseYAML(raw);
    if (!doc?.name) throw new Error(`workflow ${f} missing name`);
    if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
      throw new Error(`workflow ${doc.name} has no steps`);
    }
    doc.on_exhaustion = doc.on_exhaustion || 'block';
    // Collect predicate references and validate they resolve.
    for (const step of doc.steps) {
      for (const branch of Object.values(step.on || {})) {
        if (branch?.when) usedPredicates.add(branch.when);
      }
    }
    flows[doc.name] = doc;
  }

  for (const name of usedPredicates) {
    if (typeof predicates[name] !== 'function') {
      throw new Error(`unknown predicate: ${name}`);
    }
  }
  return flows;
}
```

- [ ] **Step 9: Run loader test — expect PASS**

```bash
npm test -- tests/worker/engine-loader.test.js
```

Expected: PASS all 3 assertions.

- [ ] **Step 10: Commit**

```bash
git add src/worker/predicates.js src/worker/engine.js \
        src/worker/workflows/ \
        tests/worker/predicates.test.js tests/worker/engine-loader.test.js
git commit -m "feat(workflow): add YAML loader, predicate registry, and three workflow definitions"
```

---

## Task 3 (T03): `triggerNext` engine logic (pure, not yet wired)

**Files:**
- Modify: `src/worker/engine.js` (add `triggerNext`, `applyTransition` helpers)
- Create: `tests/worker/engine-transitions.test.js`

- [ ] **Step 1: Write the transition-evaluator test**

Create `tests/worker/engine-transitions.test.js`:

```js
// tests/worker/engine-transitions.test.js
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase } from '../../src/server/db.js';
import {
  createInstance, loadInstance, updateInstance
} from '../../src/server/workflow-instances.js';
import { triggerNext } from '../../src/worker/engine.js';

const FLOWS = {
  'work-item': {
    name: 'work-item', max_revisions: 3, on_exhaustion: 'block',
    steps: [
      { agent: 'builder',  on: { done: { next: 'reviewer' },
                                 blocked: { next: 'pm', workflow: 'replan' },
                                 failed: { terminal: true } } },
      { agent: 'reviewer', retreat_allowed: ['builder'],
        on: { done: { next: 'qa' },
              blocked: { next: 'pm', workflow: 'replan' },
              failed: { next: 'builder', when: 'reviewer_rejected_pr' } } },
      { agent: 'qa', retreat_allowed: ['pm'],
        on: { done: { terminal: true },
              failed:  { next: 'pm', workflow: 'replan' },
              blocked: { next: 'pm', workflow: 'replan' } } }
    ]
  },
  replan: {
    name: 'replan', max_revisions: 1, on_exhaustion: 'block',
    steps: [{ agent: 'pm', on: { done: { terminal: true },
                                 blocked: { terminal: true },
                                 failed: { terminal: true } } }]
  }
};

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-eng-'));
  initMasterDatabase(dir);
});

function fakeJob(agent, work_item_id, overrides = {}) {
  return {
    job_id: `j-${work_item_id}-${agent}`,
    agent,
    workflow: 'work-item',
    plane: { work_item_id, module_id: 'm1', cycle_id: 'c1' },
    ...overrides
  };
}

describe('triggerNext — forward transitions', () => {
  let enqueued;
  const enqueue = vi.fn(async (payload) => {
    enqueued.push(payload); return { id: `job-${enqueued.length}` };
  });

  beforeEach(() => { enqueued = []; enqueue.mockClear(); });

  it('builder.done → enqueues reviewer, updates instance.current_step', async () => {
    createInstance({ work_item_id: 'wi-fwd1', workflow_name: 'work-item', current_step: 'builder' });
    await triggerNext({
      jobData: fakeJob('builder', 'wi-fwd1'),
      result: { status: 'done', summary: 'ok' },
      flows: FLOWS, enqueue
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].agent).toBe('reviewer');
    expect(enqueued[0].workflow).toBe('work-item');
    const inst = loadInstance({ work_item_id: 'wi-fwd1', workflow_name: 'work-item' });
    expect(inst.current_step).toBe('reviewer');
    expect(inst.status).toBe('running');
  });

  it('qa.done → instance terminal, no enqueue', async () => {
    createInstance({ work_item_id: 'wi-fwd2', workflow_name: 'work-item', current_step: 'qa' });
    await triggerNext({
      jobData: fakeJob('qa', 'wi-fwd2'),
      result: { status: 'done', summary: 'green' },
      flows: FLOWS, enqueue
    });
    expect(enqueued).toHaveLength(0);
    const inst = loadInstance({ work_item_id: 'wi-fwd2', workflow_name: 'work-item' });
    expect(inst.status).toBe('done');
  });
});

describe('triggerNext — retreat allowlist', () => {
  const enqueue = vi.fn(async () => ({ id: 'x' }));

  it('reviewer emits handoff.next_agent=builder → retreat override applied', async () => {
    createInstance({ work_item_id: 'wi-r1', workflow_name: 'work-item', current_step: 'reviewer' });
    enqueue.mockClear();
    await triggerNext({
      jobData: fakeJob('reviewer', 'wi-r1'),
      result: { status: 'failed', issues_found: [{ severity: 'p1' }] },
      flows: FLOWS, enqueue
    });
    // predicate also picks builder; retreat confirms same target
    const calls = enqueue.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].agent).toBe('builder');
  });

  it('reviewer emits handoff.next_agent=deploy → out of allowlist, rejected', async () => {
    createInstance({ work_item_id: 'wi-r2', workflow_name: 'work-item', current_step: 'reviewer' });
    enqueue.mockClear();
    await triggerNext({
      jobData: fakeJob('reviewer', 'wi-r2'),
      result: { status: 'done', handoff: { next_agent: 'deploy' } },
      flows: FLOWS, enqueue
    });
    // declared transition done→qa wins
    expect(enqueue.mock.calls[0][0].agent).toBe('qa');
  });
});

describe('triggerNext — replan and revision guard', () => {
  const enqueue = vi.fn(async () => ({ id: 'x' }));

  it('qa.failed → enqueues pm replan with parent context, parent goes awaiting_approval', async () => {
    createInstance({ work_item_id: 'wi-rp1', workflow_name: 'work-item', current_step: 'qa' });
    enqueue.mockClear();
    await triggerNext({
      jobData: fakeJob('qa', 'wi-rp1'),
      result: { status: 'failed', blockers: [{ kind: 'code', title: 'oops' }] },
      flows: FLOWS, enqueue
    });
    expect(enqueue.mock.calls).toHaveLength(1);
    const payload = enqueue.mock.calls[0][0];
    expect(payload.agent).toBe('pm');
    expect(payload.workflow).toBe('replan');
    expect(payload.parent_workflow).toBe('work-item');
    expect(payload.failed_step).toBe('qa');
    const parent = loadInstance({ work_item_id: 'wi-rp1', workflow_name: 'work-item' });
    expect(parent.status).toBe('awaiting_approval');
  });

  it('revision cap reached → on_exhaustion=block, no enqueue', async () => {
    createInstance({ work_item_id: 'wi-rp2', workflow_name: 'work-item', current_step: 'qa' });
    updateInstance({ work_item_id: 'wi-rp2', workflow_name: 'work-item' }, { revision: 3 });
    enqueue.mockClear();
    await triggerNext({
      jobData: { ...fakeJob('qa', 'wi-rp2'), workflow_revision: 3 },
      result: { status: 'failed', blockers: [{ kind: 'code' }] },
      flows: FLOWS, enqueue
    });
    expect(enqueue.mock.calls).toHaveLength(0);
    const parent = loadInstance({ work_item_id: 'wi-rp2', workflow_name: 'work-item' });
    expect(parent.status).toBe('exhausted');
    expect(parent.exhausted_at).toBeGreaterThan(0);
  });
});

describe('triggerNext — predicate gating', () => {
  const enqueue = vi.fn(async () => ({ id: 'x' }));

  it('reviewer.failed with no p1+ issue → predicate false, transition falls through to terminal', async () => {
    createInstance({ work_item_id: 'wi-pred', workflow_name: 'work-item', current_step: 'reviewer' });
    enqueue.mockClear();
    await triggerNext({
      jobData: fakeJob('reviewer', 'wi-pred'),
      result: { status: 'failed', issues_found: [{ severity: 'p3' }] },
      flows: FLOWS, enqueue
    });
    expect(enqueue.mock.calls).toHaveLength(0);
    const parent = loadInstance({ work_item_id: 'wi-pred', workflow_name: 'work-item' });
    expect(parent.status).toBe('failed');
  });
});

describe('triggerNext — replan resume', () => {
  const enqueue = vi.fn(async () => ({ id: 'x' }));

  it('replan pm.done → bumps parent revision and re-enqueues first step of parent workflow', async () => {
    createInstance({ work_item_id: 'wi-rs1', workflow_name: 'work-item', current_step: 'qa' });
    updateInstance({ work_item_id: 'wi-rs1', workflow_name: 'work-item' },
                   { status: 'awaiting_approval', revision: 1 });
    const replanId = createInstance({
      work_item_id: 'wi-rs1', workflow_name: 'replan',
      current_step: 'pm',
      metadata: { parent_workflow: 'work-item', parent_revision: 1 }
    });
    enqueue.mockClear();
    await triggerNext({
      jobData: { job_id: 'jp', agent: 'pm', workflow: 'replan',
                 workflow_instance_id: replanId,
                 plane: { work_item_id: 'wi-rs1' } },
      result: { status: 'done', summary: 'replanned' },
      flows: FLOWS, enqueue
    });
    expect(enqueue.mock.calls).toHaveLength(1);
    expect(enqueue.mock.calls[0][0].agent).toBe('builder');
    expect(enqueue.mock.calls[0][0].workflow).toBe('work-item');
    expect(enqueue.mock.calls[0][0].workflow_revision).toBe(2);
    const parent = loadInstance({ work_item_id: 'wi-rs1', workflow_name: 'work-item' });
    expect(parent.revision).toBe(2);
    expect(parent.status).toBe('running');
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
npm test -- tests/worker/engine-transitions.test.js
```

Expected: FAIL — `triggerNext` not exported.

- [ ] **Step 3: Implement `triggerNext` in `src/worker/engine.js`**

Append to `src/worker/engine.js` (keeping the existing `loadWorkflows`):

```js
import {
  loadInstance, createInstance, updateInstance, loadInstanceById
} from '../server/workflow-instances.js';
import { predicates } from './predicates.js';

function findStep(flow, agent) {
  return flow.steps.find(s => s.agent === agent);
}

function pickBranch(step, status, result) {
  const branch = step.on?.[status];
  if (!branch) return null;
  if (branch.when) {
    const pred = predicates[branch.when];
    if (!pred || !pred(result)) return null;
  }
  return branch;
}

function applyRetreat(branch, step, result) {
  const hint = result?.handoff?.next_agent;
  if (!hint || !step.retreat_allowed) return { branch, override: null };
  if (step.retreat_allowed.includes(hint)) {
    return { branch: { ...branch, next: hint, _retreat: true }, override: hint };
  }
  return { branch, override: 'rejected' };
}

/**
 * Pure entry point for the workflow engine.
 * @param {object}   args
 * @param {object}   args.jobData   The BullMQ job payload that just finished.
 * @param {object}   args.result    Parsed agent output JSON.
 * @param {object}   args.flows     Workflow dictionary from loadWorkflows().
 * @param {function} args.enqueue   async (payload, opts?) => ({ id })
 * @param {function} [args.emit]    Optional SSE emitter: (event, data) => void.
 */
export async function triggerNext({ jobData, result, flows, enqueue, emit = () => {} }) {
  if (!jobData?.workflow) {
    // One-off job (deploy, ad-hoc). Engine is a no-op.
    return { action: 'no-workflow' };
  }
  const flow = flows[jobData.workflow];
  if (!flow) {
    throw new Error(`workflow not found: ${jobData.workflow}`);
  }
  const workItemId = jobData.plane?.work_item_id;
  if (!workItemId) throw new Error('triggerNext: missing plane.work_item_id');

  const instance = loadInstance({
    work_item_id: workItemId,
    workflow_name: flow.name
  });
  if (!instance) {
    throw new Error(`no workflow_instance for (${workItemId}, ${flow.name})`);
  }

  const step = findStep(flow, jobData.agent);
  if (!step) {
    updateInstance({ work_item_id: workItemId, workflow_name: flow.name },
                   { status: 'failed', last_job_id: jobData.job_id });
    throw new Error(`no step for agent ${jobData.agent} in workflow ${flow.name}`);
  }

  let branch = pickBranch(step, result.status, result);
  if (!branch) {
    updateInstance({ work_item_id: workItemId, workflow_name: flow.name },
                   { status: result.status || 'failed', last_job_id: jobData.job_id });
    emit('workflow.finished', {
      instance_id: instance.id, status: result.status || 'failed'
    });
    // Replan resume hook fires even on terminal-no-branch paths (e.g. replan pm.done).
    await maybeResumeParent(instance, flow, result, flows, enqueue, emit);
    return { action: 'terminal', reason: 'no-matching-branch' };
  }

  const { branch: effective } = applyRetreat(branch, step, result);

  // Terminal branch
  if (effective.terminal) {
    updateInstance({ work_item_id: workItemId, workflow_name: flow.name },
                   { status: result.status, last_job_id: jobData.job_id });
    emit('workflow.finished', { instance_id: instance.id, status: result.status });
    await maybeResumeParent(instance, flow, result, flows, enqueue, emit);
    return { action: 'terminal' };
  }

  // Replan branch (child workflow)
  if (effective.workflow === 'replan') {
    updateInstance({ work_item_id: workItemId, workflow_name: flow.name },
                   { status: 'awaiting_approval', last_job_id: jobData.job_id });

    createInstance({
      work_item_id: workItemId,
      workflow_name: 'replan',
      current_step: 'pm',
      module_id: instance.module_id,
      cycle_id: instance.cycle_id,
      metadata: {
        parent_workflow: flow.name,
        parent_revision: instance.revision,
        parent_instance_id: instance.id,
        failed_step: jobData.agent
      }
    });

    await enqueue({
      agent: 'pm',
      workflow: 'replan',
      plane: jobData.plane,
      work_item: jobData.work_item,
      context: jobData.context,
      parent_workflow: flow.name,
      parent_revision: instance.revision,
      parent_instance_id: instance.id,
      failed_step: jobData.agent,
      issues_found: result.issues_found || [],
      blockers: result.blockers || []
    });
    emit('workflow.transitioned', {
      instance_id: instance.id, from_agent: jobData.agent, to_agent: 'pm', reason: 'replan'
    });
    return { action: 'replan' };
  }

  // Forward (or retreat) transition within the same workflow
  if (effective.next) {
    const currentRev = jobData.workflow_revision ?? instance.revision;
    if (currentRev > flow.max_revisions) {
      return applyExhaustion(instance, flow, emit);
    }
    await enqueue({
      agent: effective.next,
      workflow: flow.name,
      workflow_instance_id: instance.id,
      workflow_revision: currentRev,
      plane: jobData.plane,
      work_item: jobData.work_item,
      context: jobData.context
    });
    updateInstance({ work_item_id: workItemId, workflow_name: flow.name },
                   { current_step: effective.next, last_job_id: jobData.job_id });
    emit('workflow.transitioned', {
      instance_id: instance.id,
      from_agent: jobData.agent, to_agent: effective.next,
      reason: effective._retreat ? 'retreat' : 'forward'
    });
    return { action: 'next', agent: effective.next };
  }

  throw new Error(`branch for ${flow.name}/${jobData.agent}/${result.status} has no action`);
}

function applyExhaustion(instance, flow, emit) {
  if (flow.on_exhaustion === 'block' || flow.on_exhaustion === 'escalate') {
    updateInstance(
      { work_item_id: instance.work_item_id, workflow_name: flow.name },
      { status: 'exhausted' }
    );
    emit('workflow.finished', { instance_id: instance.id, status: 'exhausted' });
    return { action: 'exhausted' };
  }
  // 'continue' — rare; log and keep going is not needed for any shipped flow.
  return { action: 'exhausted-continue' };
}

async function maybeResumeParent(instance, flow, result, flows, enqueue, emit) {
  if (flow.name !== 'replan') return;
  let meta;
  try { meta = instance.metadata ? JSON.parse(instance.metadata) : null; }
  catch { meta = null; }
  if (!meta?.parent_instance_id) return;

  const parent = loadInstanceById(meta.parent_instance_id);
  if (!parent) return;
  const parentFlow = flows[parent.workflow_name];
  if (!parentFlow) return;

  if (result.status === 'done') {
    const firstAgent = parentFlow.steps[0].agent;
    const newRev = parent.revision + 1;
    if (newRev > parentFlow.max_revisions) {
      return applyExhaustion(parent, parentFlow, emit);
    }
    await enqueue({
      agent: firstAgent,
      workflow: parent.workflow_name,
      workflow_instance_id: parent.id,
      workflow_revision: newRev,
      plane: { work_item_id: parent.work_item_id,
               module_id: parent.module_id,
               cycle_id: parent.cycle_id }
    });
    updateInstance(
      { work_item_id: parent.work_item_id, workflow_name: parent.workflow_name },
      { status: 'running', revision: newRev, current_step: firstAgent }
    );
    emit('workflow.transitioned', {
      instance_id: parent.id, from_agent: 'pm', to_agent: firstAgent,
      reason: 'replan-resume'
    });
  } else {
    // replan blocked/failed → parent stays awaiting_approval; leave for human.
    emit('workflow.finished', {
      instance_id: parent.id, status: 'awaiting_approval', reason: 'replan-failed'
    });
  }
}
```

- [ ] **Step 4: Run transitions test — expect PASS all**

```bash
npm test -- tests/worker/engine-transitions.test.js
```

Expected: PASS 8 assertions (forward, terminal, retreat-in, retreat-out, replan enqueue, revision cap, predicate gate, replan resume).

- [ ] **Step 5: Commit**

```bash
git add src/worker/engine.js tests/worker/engine-transitions.test.js
git commit -m "feat(workflow): add triggerNext transition evaluator with retreat, replan, revision guard"
```

---

## Task 4 (T04): Wire `triggerNext` into `runAutomation` + strip legacy chain

**Files:**
- Modify: `src/worker/automation.js` (replace stub at line 116)
- Modify: `src/worker/index.js` (remove legacy builder→reviewer chain at lines 208-240)
- Modify: `src/worker/prompt-builder.js` (pass `workflow_instance_id` + `workflow_revision` through to prompt context)
- Create: `tests/worker/automation-triggerNext.test.js`

- [ ] **Step 1: Write the integration test**

Create `tests/worker/automation-triggerNext.test.js`:

```js
// tests/worker/automation-triggerNext.test.js
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase } from '../../src/server/db.js';
import { createInstance, loadInstance } from '../../src/server/workflow-instances.js';
import { runAutomation, __setEnqueueForTests } from '../../src/worker/automation.js';

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-auto-'));
  initMasterDatabase(dir);
});

describe('runAutomation — workflow.trigger_next wiring', () => {
  it('job with no workflow field is a clean no-op for the engine', async () => {
    const enqueue = vi.fn();
    __setEnqueueForTests(enqueue);
    await runAutomation({
      jobData: { job_id: 'j-oneoff', agent: 'builder', plane: {}, work_item: {} },
      result: { status: 'done', summary: 'x', memory_writes_count: 0 },
      startedAt: Date.now() - 10
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('workflow job → engine enqueues next agent', async () => {
    createInstance({ work_item_id: 'wi-A', workflow_name: 'work-item', current_step: 'builder' });
    const enqueue = vi.fn().mockResolvedValue({ id: 'new-job' });
    __setEnqueueForTests(enqueue);
    await runAutomation({
      jobData: {
        job_id: 'j-A', agent: 'builder',
        workflow: 'work-item', workflow_revision: 1,
        plane: { work_item_id: 'wi-A' }, work_item: { title: 't' }
      },
      result: { status: 'done', summary: 'built', memory_writes_count: 0 },
      startedAt: Date.now() - 10
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].agent).toBe('reviewer');
    const inst = loadInstance({ work_item_id: 'wi-A', workflow_name: 'work-item' });
    expect(inst.current_step).toBe('reviewer');
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
npm test -- tests/worker/automation-triggerNext.test.js
```

Expected: FAIL — `__setEnqueueForTests` not exported; step 7 still a stub.

- [ ] **Step 3: Replace the stub in `src/worker/automation.js`**

At the top of `src/worker/automation.js`, add imports and a lazy enqueue. Reuse the existing `publishEvent(...)` function already in this file (it HTTP-POSTs to `WORKER_EVENTS_URL`) — worker and server live on different nodes in prod, so direct `broadcastAdmin` would not cross the boundary:

```js
import { loadWorkflows, triggerNext } from './engine.js';
import { getQueue, QUEUES, PRIORITY_MAP } from '../server/bullmq.js';

let _flows = null;
function getFlows() {
  if (!_flows) _flows = loadWorkflows();
  return _flows;
}

// Replaceable for tests
let _enqueue = async (payload) => {
  const queue = getQueue(QUEUES.agents);
  const prio = PRIORITY_MAP[payload.priority || 'p2'] || 10;
  const name = `${payload.agent}:${payload.plane?.work_item_id || 'adhoc'}`;
  return queue.add(name, payload, { priority: prio });
};

export function __setEnqueueForTests(fn) { _enqueue = fn; }

// publishEvent already exists in this file from Spec 1 — it HTTP-POSTs
// to the services-node /api/admin/events/publish endpoint.
function emitEvent(event, data) {
  publishEvent(event, data).catch(() => {}); // SSE is best-effort
}
```

Then replace lines 116-118 (the stub `logStep({... step: 'workflow.trigger_next', status: 'stub', ...})`) with:

```js
  await runStep(job_id, agent, 'workflow.trigger_next',
    () => triggerNext({
      jobData, result,
      flows: getFlows(),
      enqueue: _enqueue,
      emit: emitEvent
    }));
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
npm test -- tests/worker/automation-triggerNext.test.js
```

Expected: PASS both cases.

- [ ] **Step 5: Propagate workflow fields in `prompt-builder.js`**

Open `src/worker/prompt-builder.js`. In `buildPrompt`, the destructuring of `jobData` currently omits workflow fields. Add them — they are informational for the agent (so PM replan mode can read `parent_workflow`):

```js
const {
  job_id, agent, mode = 'autonomous',
  workflow = null, workflow_instance_id = null, workflow_revision = null,
  parent_workflow = null, parent_revision = null, failed_step = null,
  issues_found = [], blockers = [],
  plane = {}, work_item = {}, context = {},
  required_skills = [], allowed_mcp = [], memory_namespace = 'dev-panel'
} = jobData;
```

Inside the prompt assembly, add a small context block (only if workflow is set):

```js
if (workflow) {
  sections.push(
    `## Workflow context\n\n` +
    `- workflow: ${workflow}\n` +
    `- instance_id: ${workflow_instance_id}\n` +
    `- revision: ${workflow_revision}\n` +
    (parent_workflow ? `- parent_workflow: ${parent_workflow}\n` +
                       `- parent_revision: ${parent_revision}\n` +
                       `- failed_step: ${failed_step}\n` : '')
  );
}
```

- [ ] **Step 6: Strip the legacy builder→reviewer chain from `src/worker/index.js`**

In `src/worker/index.js`, find the block starting around line 208 (`// Chain: builder (tests passed) -> reviewer` through the reviewer autonomous chain ending ~line 240). Delete both `if` blocks. Keep the `worker.on('completed', ...)` signature intact (the morning-review logging above stays; just remove the pipeline-chaining `if` statements). Leave a one-line comment:

```js
// Chaining is owned by workflow.trigger_next (see src/worker/engine.js).
```

Why: the old chain double-dispatches on every workflow job because `triggerNext` already enqueues reviewer. Leaving both in would produce two reviewer jobs per builder completion.

- [ ] **Step 7: Run full test suite — no regressions**

```bash
npm test
```

Expected: all tests green; new automation-triggerNext cases included.

- [ ] **Step 8: Commit**

```bash
git add src/worker/automation.js src/worker/index.js src/worker/prompt-builder.js \
        tests/worker/automation-triggerNext.test.js
git commit -m "feat(workflow): wire triggerNext into runAutomation, drop legacy chain"
```

---

## Task 5 (T05): Dispatch entrypoints — helper, MCP tools, CLI

**Files:**
- Create: `src/worker/dispatch.js`
- Modify: `src/mcp/server.js` (add 3 tools)
- Modify: `bin/dev-panel.js` (add `workflow dispatch` subcommand)
- Create: `tests/worker/dispatch.test.js`

- [ ] **Step 1: Write the dispatch helper test**

Create `tests/worker/dispatch.test.js`:

```js
// tests/worker/dispatch.test.js
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase } from '../../src/server/db.js';
import { loadInstance } from '../../src/server/workflow-instances.js';
import { enqueueWorkflowStart, __setEnqueueForTests } from '../../src/worker/dispatch.js';

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-disp-'));
  initMasterDatabase(dir);
});

describe('enqueueWorkflowStart', () => {
  it('creates instance + enqueues first step of workflow', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'j-1' });
    __setEnqueueForTests(enqueue);
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-d1', module_id: 'm', cycle_id: 'c' },
      work_item: { title: 'x' }
    });
    expect(out.ok).toBe(true);
    expect(out.instance_id).toBeGreaterThan(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].agent).toBe('builder');
    expect(enqueue.mock.calls[0][0].workflow_revision).toBe(1);
    const inst = loadInstance({ work_item_id: 'wi-d1', workflow_name: 'work-item' });
    expect(inst.status).toBe('running');
    expect(inst.current_step).toBe('builder');
  });

  it('duplicate dispatch on active instance returns { ok:false, error:"already_running" }', async () => {
    __setEnqueueForTests(vi.fn().mockResolvedValue({ id: 'j' }));
    await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-d2' }
    });
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-d2' }
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('already_running');
  });

  it('rejects unknown workflow', async () => {
    const out = await enqueueWorkflowStart({
      workflow: 'no-such-flow',
      plane: { work_item_id: 'wi-d3' }
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/unknown workflow/);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
npm test -- tests/worker/dispatch.test.js
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/worker/dispatch.js`**

```js
// src/worker/dispatch.js
import { loadWorkflows } from './engine.js';
import { createInstance } from '../server/workflow-instances.js';
import { getQueue, QUEUES, PRIORITY_MAP } from '../server/bullmq.js';

const WORKER_EVENTS_URL = process.env.WORKER_EVENTS_URL
  || 'http://localhost:3030/api/admin/events/publish';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

async function publishEvent(event, data) {
  if (!ADMIN_API_KEY) return;
  try {
    await fetch(WORKER_EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_API_KEY },
      body: JSON.stringify({ event, data })
    });
  } catch { /* SSE is best-effort */ }
}

let _flows = null;
function getFlows() {
  if (!_flows) _flows = loadWorkflows();
  return _flows;
}

let _enqueue = async (payload, opts = {}) => {
  const queue = getQueue(QUEUES.agents);
  const prio = PRIORITY_MAP[payload.priority || 'p2'] || 10;
  const name = `${payload.agent}:${payload.plane?.work_item_id || 'adhoc'}`;
  return queue.add(name, payload, { priority: prio, ...opts });
};
export function __setEnqueueForTests(fn) { _enqueue = fn; }

/**
 * Start a workflow on a work-item. Atomic: creates the instance row first,
 * then enqueues the first step. The unique partial index enforces one active
 * instance per (work_item_id, workflow_name).
 */
export async function enqueueWorkflowStart({
  workflow, plane, work_item = {}, context = {}, scheduled_for = null
}) {
  const flows = getFlows();
  const flow = flows[workflow];
  if (!flow) return { ok: false, error: `unknown workflow: ${workflow}` };
  if (!plane?.work_item_id) return { ok: false, error: 'missing plane.work_item_id' };
  const firstAgent = flow.steps[0].agent;

  let instance_id;
  try {
    instance_id = createInstance({
      work_item_id: plane.work_item_id,
      workflow_name: workflow,
      current_step: firstAgent,
      module_id: plane.module_id || null,
      cycle_id: plane.cycle_id || null
    });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return { ok: false, error: 'already_running' };
    throw e;
  }

  const opts = scheduled_for ? { delay: Math.max(0, scheduled_for - Date.now()) } : {};
  const job = await _enqueue({
    agent: firstAgent,
    workflow,
    workflow_instance_id: instance_id,
    workflow_revision: 1,
    plane,
    work_item,
    context
  }, opts);

  publishEvent('workflow.started', {
    instance_id, work_item_id: plane.work_item_id, workflow, revision: 1
  }).catch(() => {});

  return { ok: true, instance_id, job_id: job?.id ?? null };
}
```

- [ ] **Step 4: Run the dispatch test — expect PASS**

```bash
npm test -- tests/worker/dispatch.test.js
```

Expected: PASS all 3 cases.

- [ ] **Step 5: Add MCP tool `plane_dispatch_work_item`**

In `src/mcp/server.js`, after the existing `enqueue_job` tool (around line 280), add:

```js
server.tool(
  'plane_dispatch_work_item',
  'Start the work-item pipeline on a Plane work-item (PM-owned dispatch).',
  {
    work_item_id: z.string(),
    module_id: z.string().optional(),
    cycle_id: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    workflow: z.enum(['work-item']).default('work-item')
  },
  async ({ work_item_id, module_id, cycle_id, title, description, workflow }) => {
    const { enqueueWorkflowStart } = await import('../worker/dispatch.js');
    const out = await enqueueWorkflowStart({
      workflow,
      plane: { work_item_id, module_id, cycle_id },
      work_item: { title, description }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      isError: !out.ok
    };
  }
);

server.tool(
  'plane_close_cycle',
  'Mark a cycle closed in Plane and schedule its cycle-audit pipeline.',
  {
    cycle_id: z.string(),
    project_id: z.string().optional(),
    audit_at: z.string().optional().describe('ISO 8601; defaults to next 09:00 Europe/Paris')
  },
  async ({ cycle_id, project_id, audit_at }) => {
    const { enqueueWorkflowStart } = await import('../worker/dispatch.js');
    // Step A: mark the cycle closed in Plane. Non-fatal if creds are absent
    // (matches Spec 1 pattern: automation steps no-op when env is unset).
    const base = process.env.PLANE_BASE_URL;
    const slug = process.env.PLANE_WORKSPACE_SLUG;
    const token = process.env.PLANE_API_TOKEN;
    const proj = project_id || process.env.PLANE_PROJECT_ID;
    if (base && slug && token && proj) {
      try {
        await fetch(`${base}/api/v1/workspaces/${slug}/projects/${proj}/cycles/${cycle_id}/`, {
          method: 'PATCH',
          headers: { 'X-API-Key': token, 'Content-Type': 'application/json',
                     'User-Agent': 'dev-panel/close_cycle' },
          body: JSON.stringify({ end_date: new Date().toISOString() })
        });
      } catch (e) {
        console.warn('[plane_close_cycle] Plane PATCH failed:', e.message);
      }
    }
    // Step B: schedule audit
    const when = audit_at ? Date.parse(audit_at) : nextAuditTime();
    const out = await enqueueWorkflowStart({
      workflow: 'cycle-audit',
      plane: { work_item_id: `cycle:${cycle_id}`, cycle_id },
      work_item: { title: `Cycle audit ${cycle_id}` },
      scheduled_for: when
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...out, scheduled_for: when }, null, 2) }],
      isError: !out.ok
    };
  }
);

function nextAuditTime() {
  const now = new Date();
  const t = new Date(now);
  t.setHours(9, 0, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t.getTime();
}

server.tool(
  'devpanel_workflow_dispatch',
  'Operator override: start any workflow on a work-item (admin).',
  {
    work_item_id: z.string(),
    workflow: z.enum(['work-item', 'cycle-audit']).default('work-item'),
    module_id: z.string().optional(),
    cycle_id: z.string().optional()
  },
  async ({ work_item_id, workflow, module_id, cycle_id }) => {
    const { enqueueWorkflowStart } = await import('../worker/dispatch.js');
    const out = await enqueueWorkflowStart({
      workflow,
      plane: { work_item_id, module_id, cycle_id }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      isError: !out.ok
    };
  }
);
```

- [ ] **Step 6: Add CLI subcommand `workflow dispatch`**

In `bin/dev-panel.js`, register a new command. Find where other subcommands (`init`, `list`, etc.) are defined and append:

```js
program
  .command('workflow')
  .argument('<action>', 'dispatch | list')
  .argument('[work_item_id]')
  .option('--workflow <name>', 'work-item | cycle-audit', 'work-item')
  .option('--module <id>')
  .option('--cycle <id>')
  .description('Workflow engine operations')
  .action(async (action, work_item_id, opts) => {
    if (action === 'dispatch') {
      if (!work_item_id) { console.error('work_item_id is required'); process.exit(2); }
      const { enqueueWorkflowStart } = await import('../src/worker/dispatch.js');
      const out = await enqueueWorkflowStart({
        workflow: opts.workflow,
        plane: { work_item_id, module_id: opts.module, cycle_id: opts.cycle }
      });
      console.log(JSON.stringify(out, null, 2));
      process.exit(out.ok ? 0 : 1);
    }
    if (action === 'list') {
      const { listActive } = await import('../src/server/workflow-instances.js');
      console.table(listActive());
      return;
    }
    console.error(`unknown action: ${action}`);
    process.exit(2);
  });
```

- [ ] **Step 7: Manual CLI smoke**

```bash
node bin/dev-panel.js workflow list
```

Expected: empty table (no active instances in this worktree's SQLite yet). Command exits 0.

```bash
node bin/dev-panel.js workflow dispatch wi-cli-test
```

Expected: JSON output with `ok: true, instance_id: N, job_id: null-or-id`. Then `workflow list` shows one active row.

(If Redis isn't running locally the dispatch will fail at the queue add — this is expected. Fall back to the unit tests for coverage, and cover this path for real in the smoke script at Task 8.)

- [ ] **Step 8: Commit**

```bash
git add src/worker/dispatch.js src/mcp/server.js bin/dev-panel.js \
        tests/worker/dispatch.test.js
git commit -m "feat(workflow): add dispatch helper, 3 MCP tools, CLI subcommand"
```

---

## Task 6 (T06): Dashboard Pipelines pane (SSE + admin API)

**Files:**
- Modify: `src/server/routes.js` (add two admin workflow endpoints)
- Create: `src/dashboard/lib/workflow-events.js`
- Create: `src/dashboard/components/PipelinesPane.jsx`
- Modify: the existing Queues view file to mount `PipelinesPane`

- [ ] **Step 1: Add admin API endpoints**

In `src/server/routes.js`, after the existing `/admin/events/publish` route (around line 931), add:

```js
  router.get('/admin/workflows/instances', authenticateAdmin, async (req, res) => {
    const { listActive, listByCycle } = await import('./workflow-instances.js');
    const rows = req.query.cycle_id ? listByCycle(req.query.cycle_id) : listActive();
    res.json({ instances: rows });
  });

  router.get('/admin/workflows/instances/:id', authenticateAdmin, async (req, res) => {
    const { loadInstanceById } = await import('./workflow-instances.js');
    const { listSteps } = await import('./jobs-log.js');
    const instance = loadInstanceById(parseInt(req.params.id, 10));
    if (!instance) return res.status(404).json({ error: 'not found' });
    const steps = instance.last_job_id ? listSteps(instance.last_job_id) : [];
    res.json({ instance, steps });
  });
```

- [ ] **Step 2: Verify the route via curl**

```bash
ADMIN_API_KEY=devkey npm run dev:dashboard &  # if a local dev server exists
# or start the full server:
ADMIN_API_KEY=devkey node -e "import('./src/server/index.js').then(m => m.startServer(3030))"
curl -s -H "X-Admin-Key: devkey" http://localhost:3030/api/admin/workflows/instances | python3 -m json.tool
```

Expected: `{"instances": []}` (or the rows you created in Task 5 manual smoke).

- [ ] **Step 3: Create the SSE subscription module**

Create `src/dashboard/lib/workflow-events.js`:

```js
// src/dashboard/lib/workflow-events.js
// Minimal subscriber for workflow.* SSE events on the admin stream.

export function subscribeWorkflowEvents(adminKey, handlers = {}) {
  const url = `/api/admin/events`;
  const es = new EventSource(`${url}?key=${encodeURIComponent(adminKey)}`);
  for (const name of ['workflow.started', 'workflow.transitioned', 'workflow.finished']) {
    es.addEventListener(name, (e) => {
      try { handlers[name]?.(JSON.parse(e.data)); }
      catch (err) { console.warn('[workflow-events] bad payload', err); }
    });
  }
  return () => es.close();
}
```

(If the admin SSE endpoint requires the key in a header rather than a query param, the server route currently uses `authenticateAdmin` middleware. If header-only auth is enforced and EventSource can't set headers, add a query-param fallback to `authenticateAdmin` guarded by admin key equality. Confirm before assuming.)

- [ ] **Step 4: Create the Pipelines pane component**

Create `src/dashboard/components/PipelinesPane.jsx`:

```jsx
// src/dashboard/components/PipelinesPane.jsx
import { useEffect, useState } from 'react';
import { subscribeWorkflowEvents } from '../lib/workflow-events.js';

const STATUS_COLOR = {
  running: 'text-blue-500',
  awaiting_approval: 'text-amber-500',
  done: 'text-emerald-500',
  blocked: 'text-rose-500',
  failed: 'text-rose-600',
  exhausted: 'text-rose-700'
};

export function PipelinesPane({ adminKey }) {
  const [instances, setInstances] = useState([]);
  const [fadingIds, setFadingIds] = useState(new Set());

  async function refresh() {
    const r = await fetch('/api/admin/workflows/instances', {
      headers: { 'X-Admin-Key': adminKey }
    });
    const j = await r.json();
    setInstances(j.instances || []);
  }

  useEffect(() => {
    refresh();
    const unsub = subscribeWorkflowEvents(adminKey, {
      'workflow.started':      () => refresh(),
      'workflow.transitioned': () => refresh(),
      'workflow.finished':     (p) => {
        refresh();
        // terminal rows fade out after 30s
        setFadingIds(s => new Set(s).add(p.instance_id));
        setTimeout(() => {
          setInstances(rows => rows.filter(r => r.id !== p.instance_id || r.status === 'failed' || r.status === 'exhausted'));
        }, 30000);
      }
    });
    return unsub;
  }, [adminKey]);

  if (!instances.length) return <div className="text-sm text-gray-400">No active pipelines.</div>;

  const byCycle = new Map();
  for (const r of instances) {
    const k = r.cycle_id || '(no cycle)';
    if (!byCycle.has(k)) byCycle.set(k, []);
    byCycle.get(k).push(r);
  }

  return (
    <div className="space-y-4">
      {[...byCycle.entries()].map(([cycle, rows]) => (
        <section key={cycle}>
          <h3 className="text-sm font-semibold text-gray-600 mb-1">Cycle: {cycle}</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500">
                <th>Work item</th><th>Workflow</th><th>Rev</th><th>Step</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}
                    className={fadingIds.has(r.id) ? 'opacity-40 transition-opacity' : ''}>
                  <td className="font-mono">{r.work_item_id}</td>
                  <td>{r.workflow_name}</td>
                  <td>{r.revision}</td>
                  <td>{r.current_step}</td>
                  <td className={STATUS_COLOR[r.status] || ''}>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Mount the pane on the Queues view**

Find the Queues view file (likely `src/dashboard/App.jsx` or a `QueuesView.jsx`) by grep:

```bash
grep -l "Queues\|BullBoard\|queue" src/dashboard -r
```

In that file's render block, after the existing queue health/BullBoard summary, add:

```jsx
import { PipelinesPane } from './components/PipelinesPane.jsx';

// inside the component's JSX, e.g. at the bottom of the Queues section:
<section className="mt-6">
  <h2 className="text-lg font-semibold mb-2">Pipelines</h2>
  <PipelinesPane adminKey={adminKey} />
</section>
```

Use the same `adminKey` prop the page already uses for admin SSE.

- [ ] **Step 6: Build the dashboard to catch typos**

```bash
npx vite build
```

Expected: clean build, no import errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/routes.js \
        src/dashboard/lib/workflow-events.js \
        src/dashboard/components/PipelinesPane.jsx \
        src/dashboard/App.jsx  # or whichever file mounts the pane
git commit -m "feat(workflow): add Pipelines pane + admin workflow API"
```

---

## Task 7 (T07): SOUL touch-ups — reviewer, qa, pm

**Files:**
- Modify: `.agents/reviewer/SOUL.md`
- Modify: `.agents/qa/SOUL.md`
- Modify: `.agents/pm/SOUL.md`

- [ ] **Step 1: Reviewer — declare retreat allowlist**

Open `.agents/reviewer/SOUL.md`. Find the `## Handoff` section. Replace or append so it reads (keep existing handoff copy; add the retreat line):

```markdown
## Handoff

On done (merge approved): hand off to **qa**.

On rejection (serious issues): retreat to **builder** — set
`handoff.next_agent = "builder"` in the output JSON. This is the only
allowed retreat; any other value is rejected by the engine.

`handoff.retreat_allowed: [builder]`
```

- [ ] **Step 2: QA — declare retreat allowlist**

Open `.agents/qa/SOUL.md`. Same treatment in `## Handoff`:

```markdown
## Handoff

On done: pipeline terminal (work-item merged + validated).

On failure: retreat to **pm** — set `handoff.next_agent = "pm"` in the
output JSON. If every blocker has `kind: "infra"`, the engine will route
to a simple retry rather than a full replan.

`handoff.retreat_allowed: [pm]`
```

- [ ] **Step 3: QA — require infra/code tagging of blockers**

Still in `.agents/qa/SOUL.md`, in the `## You MUST` section, add a rule:

```markdown
- Tag every entry in `blockers` with `kind: "infra" | "code"`. Infra means
  a transient environmental failure (Redis unreachable, DNS hiccup,
  container OOM); code means anything that reproduces with `npm test`.
  Miss-tagging infra as code triggers wasted PM replans.
```

- [ ] **Step 4: PM — add Replan mode section**

Open `.agents/pm/SOUL.md`. Add this section (before `## Handoff`):

```markdown
## Replan mode

When the job payload has `parent_workflow` set, you are NOT doing full
cycle planning. Your scope is narrow:

1. Read `issues_found` and `blockers` from the payload.
2. Call `memory_search` filtered to this `work_item_id` for prior attempts
   on this exact item (look for `kind: debug_finding` and `retrospective`).
3. Decide one of:
   - **Amend acceptance criteria** (refine scope) → emit `status: done` with
     the amended `work_item.acceptance_criteria` in your output. The engine
     bumps the parent revision and re-dispatches `builder`.
   - **Block** (needs Franck) → emit `status: blocked` with a one-sentence
     reason. Parent stays awaiting_approval; Shelly alerts Franck.
4. Do not create new Plane modules or cycles in replan mode.
```

- [ ] **Step 5: Commit**

```bash
git add .agents/reviewer/SOUL.md .agents/qa/SOUL.md .agents/pm/SOUL.md
git commit -m "feat(souls): declare retreat_allowed on reviewer/qa, add PM replan mode"
```

---

## Task 8 (T08): Smoke script

**Files:**
- Create: `scripts/smoke-workflow-engine.sh`

- [ ] **Step 1: Author the script**

Create `scripts/smoke-workflow-engine.sh`:

```bash
#!/usr/bin/env bash
# scripts/smoke-workflow-engine.sh
#
# End-to-end smoke for the workflow engine.
# Requires: local Redis, writable storage dir, env: ADMIN_API_KEY, REDIS_HOST
# (REDIS_PORT optional). Does NOT need Plane/GitHub/Voyage creds — those
# automation steps no-op without them.
#
# Scenarios:
#   1. Happy path: builder → reviewer → qa → done
#   2. Replan path: qa failed → pm replan done → revision+1 → builder
#
# Strategy: inject synthetic agent stdout via a fake `claude` shim on PATH.

set -euo pipefail

REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
export REDIS_HOST REDIS_PORT
export DEVPANEL_STORAGE="$(mktemp -d)"
export ADMIN_API_KEY="${ADMIN_API_KEY:-smoke-admin-$$}"
export WORKER_EVENTS_URL="http://localhost:3030/api/admin/events/publish"

echo "== Smoke: workflow engine =="
echo "storage:  $DEVPANEL_STORAGE"

# 1. Init DB (runs migrations via initMasterDatabase in-code)
node -e "
import('./src/server/db.js').then(({ initMasterDatabase }) => {
  initMasterDatabase(process.env.DEVPANEL_STORAGE);
  console.log('db ready at', process.env.DEVPANEL_STORAGE);
});
"

# 2. Happy path — dispatch and simulate three agent completions.
node scripts/_smoke-drive.js happy

# 3. Replan path
node scripts/_smoke-drive.js replan

echo "OK"
```

- [ ] **Step 2: Author the Node driver used by the script**

Create `scripts/_smoke-drive.js`:

```js
// scripts/_smoke-drive.js
// Drives two scenarios against a real workflow_instances DB + fake enqueue.
// No BullMQ, no claude subprocess. The engine + automation code is the
// thing under test; the "agents" are canned JSON objects.

import { initMasterDatabase } from '../src/server/db.js';
import { createInstance, loadInstance, listActive } from '../src/server/workflow-instances.js';
import { runAutomation, __setEnqueueForTests } from '../src/worker/automation.js';

initMasterDatabase(process.env.DEVPANEL_STORAGE);

const scenario = process.argv[2];
const pending = [];
__setEnqueueForTests(async (payload) => { pending.push(payload); return { id: `smoke-${pending.length}` }; });

async function run(agent, work_item_id, result, revision = 1) {
  const jobData = {
    job_id: `smoke-${agent}-${work_item_id}`,
    agent,
    workflow: (scenario === 'replan' && agent === 'pm') ? 'replan' : 'work-item',
    workflow_revision: revision,
    plane: { work_item_id, module_id: 'smoke-m', cycle_id: 'smoke-c' },
    work_item: { title: 'smoke' }
  };
  await runAutomation({ jobData, result, startedAt: Date.now() - 10 });
}

function expectEqual(a, b, msg) {
  if (a !== b) { console.error(`FAIL ${msg}: got ${a} want ${b}`); process.exit(1); }
  console.log(`OK   ${msg}`);
}

async function happy() {
  const wi = `wi-happy-${Date.now()}`;
  createInstance({ work_item_id: wi, workflow_name: 'work-item', current_step: 'builder' });
  await run('builder',  wi, { status: 'done', summary: 'built',    memory_writes_count: 0 });
  expectEqual(pending.shift().agent, 'reviewer', 'builder.done enqueues reviewer');
  await run('reviewer', wi, { status: 'done', summary: 'approved', memory_writes_count: 0 });
  expectEqual(pending.shift().agent, 'qa',       'reviewer.done enqueues qa');
  await run('qa',       wi, { status: 'done', summary: 'green',    memory_writes_count: 0 });
  expectEqual(pending.length, 0,                'qa.done is terminal');
  expectEqual(loadInstance({ work_item_id: wi, workflow_name: 'work-item' }).status, 'done', 'instance done');
}

async function replan() {
  const wi = `wi-replan-${Date.now()}`;
  createInstance({ work_item_id: wi, workflow_name: 'work-item', current_step: 'qa' });
  await run('qa', wi, { status: 'failed', blockers: [{ kind: 'code', title: 'bug' }], memory_writes_count: 0 });
  const payload = pending.shift();
  expectEqual(payload.agent, 'pm',                'qa.failed enqueues pm');
  expectEqual(payload.workflow, 'replan',         'pm job is replan workflow');
  expectEqual(loadInstance({ work_item_id: wi, workflow_name: 'work-item' }).status, 'awaiting_approval', 'parent awaits');
  await run('pm', wi, { status: 'done', summary: 'replanned', memory_writes_count: 0 }, 1);
  expectEqual(pending.shift().agent, 'builder',   'replan.done re-enqueues builder');
  expectEqual(loadInstance({ work_item_id: wi, workflow_name: 'work-item' }).revision, 2, 'parent rev=2');
  expectEqual(loadInstance({ work_item_id: wi, workflow_name: 'work-item' }).status, 'running', 'parent running again');
}

(async () => {
  if (scenario === 'happy') await happy();
  else if (scenario === 'replan') await replan();
  else { console.error('unknown scenario'); process.exit(2); }
})();
```

- [ ] **Step 3: Make the script executable**

```bash
chmod +x scripts/smoke-workflow-engine.sh
```

- [ ] **Step 4: Run the smoke locally**

```bash
./scripts/smoke-workflow-engine.sh
```

Expected: lines `OK   builder.done enqueues reviewer`, `OK   reviewer.done enqueues qa`, ..., ending with `OK`. Any `FAIL` line means a regression.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-workflow-engine.sh scripts/_smoke-drive.js
git commit -m "test(workflow): smoke script covering happy + replan paths"
```

---

## Task 9 (T09): Live dogfood — real work-item through the live worker

This task is manual validation, not a test. Run it AFTER the branch is merged to `main` and the services node has deployed. Each checkbox corresponds to an assertion you verify by eye (or curl) on real prod.

**Pre-flight:**
- Spec 2 merged to main, CI deployed to services, and `./scripts/deploy-agents.sh` pushed the worker to the agents node.
- Postgres migrated with `infra/migrations/002-workflow-instances.sql` (applied once on the agents-node SQLite — the in-code `CREATE IF NOT EXISTS` means no extra step, but verify the table exists).
- `VOYAGE_API_KEY`, `ADMIN_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `PLANE_API_TOKEN` all set on both nodes.

- [ ] **Step 1: Pick a Plane work-item under module `Workflow Engine (Spec 2)` and dispatch it via PM**

From the MCP client (or a shell with the MCP toolbelt):

```bash
# via the devpanel CLI on agents node
ssh hetzner-vps 'cd /home/deploy/dev-panel && node bin/dev-panel.js workflow dispatch <WORK_ITEM_ID>'
```

Expected: JSON with `ok: true, instance_id: <n>, job_id: <bullmq id>`.

- [ ] **Step 2: Verify the `workflow_instances` row**

```bash
ssh hetzner-vps 'sqlite3 /home/deploy/dev-panel/storage/projects.db \
  "SELECT id, work_item_id, workflow_name, revision, current_step, status FROM workflow_instances ORDER BY id DESC LIMIT 5;"'
```

Expected: the instance you dispatched, `status=running`, `current_step=builder`.

- [ ] **Step 3: Watch the live pipeline**

Open the dashboard (devpanl.dev admin view), Queues → Pipelines pane. Expected: row updates live as builder → reviewer → qa. One SSE event per transition.

- [ ] **Step 4: Verify memory writes**

```bash
ssh hetzner-vps 'psql "postgres://agent_memory:...@localhost/agent_memory" -c \
  "SELECT agent, kind, title FROM memories WHERE created_at > NOW() - INTERVAL '1 hour' ORDER BY created_at DESC LIMIT 10;"'
```

Expected: at least one write from builder, reviewer, qa (per the shared-memory skill contract).

- [ ] **Step 5: Verify Shelly pings**

Telegram channel receives one line per agent transition: `[builder] ... DONE`, `[reviewer] ... DONE`, `[qa] ... DONE`. Plain ASCII, no emoji, <3 lines total.

- [ ] **Step 6: Terminate validation**

If all five of the above landed cleanly, Spec 2 is live. Use `superpowers:finishing-a-development-branch` to decide merge path.

If any step fails, capture the failing artifact (dashboard screenshot, sqlite row, telegram missing), open a blocker work-item under Spec 2 referencing it, and triage before declaring Spec 2 done.

---

## Spec coverage self-review

Spec sections → tasks:

- §1 Topology (hybrid declarative) → Task 3 (retreat allowlist in `applyRetreat`).
- §2 YAMLs → Task 2 (three files + loader).
- §3 Data model → Task 1 (schema + CRUD + prod migration).
- §4 Engine logic — triggerNext/replan/on_exhaustion → Task 3.
- §5 Dispatch entry points → Task 5 (helper + 3 MCP + CLI).
- §6 Payload extension → Tasks 4 and 5 (fields in engine + dispatch).
- §7 SOUL touch-ups → Task 7.
- §8 Pipelines pane → Task 6.
- §9 Testing strategy → Tasks 1–5 (unit) + Task 8 (smoke) + Task 9 (dogfood).
- §10 Risks — YAML drift / predicate validation → Task 2 (loader rejects unknown predicates). Replan loop safety → Task 3 (revision guard). Dual dispatch race → Task 1 (unique index) + Task 5 (clean `already_running`).
- §11 Rollout order → tasks are ordered 1→9 matching the spec.
- §12 Next step → writing this plan (done).

One soft spot worth naming: risk §10.3 "infra-flake retry" ships as a tagged path in the QA SOUL (Task 7 step 3) and the predicate `qa_infra_only` exists, but no workflow branch currently uses it. That's intentional for Spec 2 — the predicate is in place and the SOUL tells QA how to tag, so when the first real infra flake happens we add the `when: qa_infra_only` branch to the YAML without any code change. Tracked via the ordinary work-item flow.
