# PR Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead GitHub-webhook path for `merge-coordinator` dispatch with a scheduled poller that reads managed repos from the `projects` table, lists open PRs, and dispatches a `merge-coordinator` workflow per PR (idempotent via existing synthetic-id index).

**Architecture:** Reuse the BullMQ repeatable-job pattern already used by `shelly:morning-digest` (deterministic handler, no `claude -p`). Add one new agent kind `pr_scanner`, one cron entry every 5 min, one handler that reads `projects` (where both `github_owner` and `github_repo` are non-null), calls GitHub REST `GET /repos/{owner}/{repo}/pulls?state=open` per project, and for each open PR calls the existing `enqueueWorkflowStart({workflow:'merge-coordinator', ...})`. Idempotence is already guaranteed by `hasActiveInstance()` from `webhooks-github.js` plus the unique partial index on `workflow_instances`. Also add an MCP tool `pr_scan` so Shelly can fire the same scan on demand. The webhook handler stays in place (dead path until we have admin scope on a repo) — no removals.

**Tech Stack:** Node ESM, BullMQ repeatable jobs, better-sqlite3 (master `projects.db`), Octokit `@octokit/rest` (already in `src/server/github.js`), existing `extractPlaneRef` + `syntheticWorkItemId` from `webhooks-github.js`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/worker/handlers/pr-scanner.js` | New. Pure handler: list managed projects, hit GitHub per repo, dispatch one `merge-coordinator` per open PR. Reuses `extractPlaneRef`, `syntheticWorkItemId`, `hasActiveInstance` from `webhooks-github.js` and `enqueueWorkflowStart` from `dispatch.js`. |
| `src/worker/crons.js` | Modify. Add a fifth `CRON_JOBS` entry `pr:scanner` with pattern `*/5 * * * *`. |
| `src/worker/index.js` | Modify. Add a third `if (jobData.agent === 'pr_scanner')` branch alongside `bootstrap` and `shelly_digest`, dispatching to `handlePrScanner`. |
| `src/worker/worktree.js` | Modify. Add `'pr_scanner'` to the pre-spawn (no-worktree) agent list. |
| `src/mcp/server.js` | Modify. Register one new tool `pr_scan` that calls `handlePrScanner` synchronously and returns a summary `{ projects_scanned, prs_seen, dispatched, skipped_active }`. |
| `tests/worker/pr-scanner.test.js` | New. Vitest. Mock GitHub API + dispatch + DB. Cover: no projects, project missing github_*, repo with 0 PRs, repo with 2 PRs (one already active → skipped), Octokit 404 on a repo (logged, others continue). |

The webhook code in `src/server/webhooks-github.js` stays untouched — it's still a valid path the day we get admin scope on a repo.

---

## Task 1: Test scaffolding for `pr-scanner` handler

**Files:**
- Create: `tests/worker/pr-scanner.test.js`

- [ ] **Step 1: Write the failing test for the empty-projects case**

```javascript
// tests/worker/pr-scanner.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listProjectsMock = vi.fn();
const enqueueWorkflowStartMock = vi.fn();
const hasActiveInstanceMock = vi.fn();
const octokitListMock = vi.fn();

vi.mock('../../src/server/db.js', () => ({
  listProjects: listProjectsMock
}));
vi.mock('../../src/worker/dispatch.js', () => ({
  enqueueWorkflowStart: enqueueWorkflowStartMock
}));
vi.mock('../../src/server/webhooks-github.js', async () => {
  const actual = await vi.importActual('../../src/server/webhooks-github.js');
  return { ...actual, hasActiveInstance: hasActiveInstanceMock };
});
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    pulls: { list: octokitListMock }
  }))
}));

import { handlePrScanner } from '../../src/worker/handlers/pr-scanner.js';

describe('handlePrScanner', () => {
  beforeEach(() => {
    listProjectsMock.mockReset();
    enqueueWorkflowStartMock.mockReset();
    hasActiveInstanceMock.mockReset();
    octokitListMock.mockReset();
  });

  it('returns zeroed summary when no projects are registered', async () => {
    listProjectsMock.mockReturnValue([]);
    const result = await handlePrScanner({});
    expect(result).toEqual({
      projects_scanned: 0,
      prs_seen: 0,
      dispatched: 0,
      skipped_active: 0,
      errors: []
    });
    expect(octokitListMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails (handler not yet defined)**

Run: `npm run test -- tests/worker/pr-scanner.test.js`
Expected: FAIL with module-not-found for `../../src/worker/handlers/pr-scanner.js`.

- [ ] **Step 3: Commit**

```bash
git add tests/worker/pr-scanner.test.js
git commit -m "test(pr-scanner): empty projects case (red)"
```

---

## Task 2: Minimal `handlePrScanner` to pass empty-projects test

**Files:**
- Create: `src/worker/handlers/pr-scanner.js`

- [ ] **Step 1: Write the minimal handler**

```javascript
// src/worker/handlers/pr-scanner.js
// Scheduled poller: lists managed projects, hits GitHub per repo, dispatches
// one merge-coordinator workflow per open PR. Idempotence handled by
// hasActiveInstance + the unique partial index on workflow_instances.
import { Octokit } from '@octokit/rest';
import { listProjects } from '../../src/server/db.js';
import { enqueueWorkflowStart } from '../dispatch.js';
import {
  hasActiveInstance,
  syntheticWorkItemId,
  extractPlaneRef
} from '../../src/server/webhooks-github.js';

export async function handlePrScanner(_jobData = {}) {
  const summary = {
    projects_scanned: 0,
    prs_seen: 0,
    dispatched: 0,
    skipped_active: 0,
    errors: []
  };

  const projects = listProjects().filter(
    p => p.github_owner && p.github_repo
  );

  if (projects.length === 0) return summary;

  return summary; // expanded in next tasks
}
```

Note: the import path is `../../src/server/db.js` because handlers live two
levels below `src/`. Adjust if vitest disagrees — the current code in
`src/worker/handlers/shelly-digest.js` uses `../../server/...` (one less
`src`); copy that convention exactly. **Use the same `../../server/db.js`
form as siblings; the import in this snippet should read `../../server/db.js`,
not `../../src/server/db.js`.** Check the sibling file before writing.

- [ ] **Step 2: Re-check sibling import convention**

Run: `head -5 src/worker/handlers/shelly-digest.js`
Expected: `import` lines using `../../server/...`. Use the same form in `pr-scanner.js`. Update the test mock paths in `tests/worker/pr-scanner.test.js` to match if needed (replace `../../src/server/db.js` with `../../src/server/db.js` is correct **from the test file** — tests live at `tests/worker/`, so `../../src/server/db.js` IS right; only the handler uses the shorter form).

- [ ] **Step 3: Run the test to confirm it now passes**

Run: `npm run test -- tests/worker/pr-scanner.test.js`
Expected: PASS (1/1).

- [ ] **Step 4: Commit**

```bash
git add src/worker/handlers/pr-scanner.js
git commit -m "feat(pr-scanner): minimal handler skeleton (green)"
```

---

## Task 3: Test — single project, single open PR, dispatch fires

**Files:**
- Modify: `tests/worker/pr-scanner.test.js`

- [ ] **Step 1: Add the failing test**

```javascript
  it('dispatches merge-coordinator for one open PR on one project', async () => {
    listProjectsMock.mockReturnValue([
      { id: 'p1', name: 'edms', github_owner: 'EpitechAfrik', github_repo: 'EDMS' }
    ]);
    octokitListMock.mockResolvedValue({
      data: [{
        number: 6,
        title: 'feat: add upload retry',
        body: 'fixes EDMS-17',
        head: { ref: 'feat/upload-retry', sha: 'abc123' }
      }]
    });
    hasActiveInstanceMock.mockResolvedValue(false);
    enqueueWorkflowStartMock.mockResolvedValue({ ok: true, instance_id: 'i1', job_id: 'j1' });

    const result = await handlePrScanner({});

    expect(result.projects_scanned).toBe(1);
    expect(result.prs_seen).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(result.skipped_active).toBe(0);
    expect(enqueueWorkflowStartMock).toHaveBeenCalledTimes(1);
    expect(enqueueWorkflowStartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'merge-coordinator',
        plane: { work_item_id: 'github:EpitechAfrik/EDMS#6' },
        work_item: expect.objectContaining({ title: 'feat: add upload retry' }),
        context: expect.objectContaining({
          github: expect.objectContaining({
            repo: 'EpitechAfrik/EDMS',
            pr_number: 6,
            head_sha: 'abc123',
            branch: 'feat/upload-retry'
          })
        })
      })
    );
  });
```

- [ ] **Step 2: Run — confirm it fails**

Run: `npm run test -- tests/worker/pr-scanner.test.js`
Expected: FAIL — `dispatched` is `0`, `enqueueWorkflowStartMock` not called.

- [ ] **Step 3: Commit (red)**

```bash
git add tests/worker/pr-scanner.test.js
git commit -m "test(pr-scanner): single open PR dispatch (red)"
```

---

## Task 4: Implement single-PR dispatch loop

**Files:**
- Modify: `src/worker/handlers/pr-scanner.js`

- [ ] **Step 1: Replace the body to iterate projects + PRs**

```javascript
// src/worker/handlers/pr-scanner.js
import { Octokit } from '@octokit/rest';
import { listProjects } from '../../server/db.js';
import { enqueueWorkflowStart } from '../dispatch.js';
import {
  hasActiveInstance,
  syntheticWorkItemId,
  extractPlaneRef
} from '../../server/webhooks-github.js';

function buildOctokit() {
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
}

export async function handlePrScanner(_jobData = {}) {
  const summary = {
    projects_scanned: 0,
    prs_seen: 0,
    dispatched: 0,
    skipped_active: 0,
    errors: []
  };

  const projects = listProjects().filter(
    p => p.github_owner && p.github_repo
  );
  if (projects.length === 0) return summary;

  const octokit = buildOctokit();

  for (const project of projects) {
    const repo = `${project.github_owner}/${project.github_repo}`;
    summary.projects_scanned += 1;

    let prs;
    try {
      const { data } = await octokit.pulls.list({
        owner: project.github_owner,
        repo: project.github_repo,
        state: 'open',
        per_page: 50
      });
      prs = data;
    } catch (err) {
      summary.errors.push({ repo, error: err.message });
      continue;
    }

    for (const pr of prs) {
      summary.prs_seen += 1;
      const synthetic = syntheticWorkItemId(repo, pr.number);

      if (await hasActiveInstance(repo, pr.number)) {
        summary.skipped_active += 1;
        continue;
      }

      const planeRef = extractPlaneRef(pr.head?.ref, pr.title);

      const result = await enqueueWorkflowStart({
        workflow: 'merge-coordinator',
        plane: { work_item_id: synthetic },
        work_item: {
          title: pr.title || `PR #${pr.number}`,
          description: pr.body || ''
        },
        context: {
          github: {
            repo,
            pr_number: pr.number,
            head_sha: pr.head?.sha,
            branch: pr.head?.ref,
            plane_ref: planeRef
          }
        }
      });

      if (result.ok) {
        summary.dispatched += 1;
        console.log(`[pr-scanner] dispatched merge-coordinator for ${repo}#${pr.number} instance=${result.instance_id}`);
      } else if (result.error === 'already_running') {
        summary.skipped_active += 1;
      } else {
        summary.errors.push({ repo, pr: pr.number, error: result.error });
      }
    }
  }

  return summary;
}
```

- [ ] **Step 2: Run — confirm both tests pass**

Run: `npm run test -- tests/worker/pr-scanner.test.js`
Expected: PASS (2/2).

- [ ] **Step 3: Commit**

```bash
git add src/worker/handlers/pr-scanner.js
git commit -m "feat(pr-scanner): list PRs and dispatch merge-coordinator"
```

---

## Task 5: Test — already-active PR is skipped, NOT re-dispatched

**Files:**
- Modify: `tests/worker/pr-scanner.test.js`

- [ ] **Step 1: Add the test**

```javascript
  it('skips PRs that already have an active merge-coordinator', async () => {
    listProjectsMock.mockReturnValue([
      { id: 'p1', name: 'edms', github_owner: 'EpitechAfrik', github_repo: 'EDMS' }
    ]);
    octokitListMock.mockResolvedValue({
      data: [
        { number: 6, title: 'PR 6', body: '', head: { ref: 'b1', sha: 's1' } },
        { number: 7, title: 'PR 7', body: '', head: { ref: 'b2', sha: 's2' } }
      ]
    });
    hasActiveInstanceMock.mockImplementation(async (_repo, n) => n === 6);
    enqueueWorkflowStartMock.mockResolvedValue({ ok: true, instance_id: 'i', job_id: 'j' });

    const result = await handlePrScanner({});

    expect(result.prs_seen).toBe(2);
    expect(result.dispatched).toBe(1);
    expect(result.skipped_active).toBe(1);
    expect(enqueueWorkflowStartMock).toHaveBeenCalledTimes(1);
    expect(enqueueWorkflowStartMock.mock.calls[0][0].plane.work_item_id)
      .toBe('github:EpitechAfrik/EDMS#7');
  });
```

- [ ] **Step 2: Run — should already pass (covered by current impl)**

Run: `npm run test -- tests/worker/pr-scanner.test.js`
Expected: PASS (3/3).

- [ ] **Step 3: Commit**

```bash
git add tests/worker/pr-scanner.test.js
git commit -m "test(pr-scanner): skip already-active PRs"
```

---

## Task 6: Test — Octokit error on one repo doesn't break the others

**Files:**
- Modify: `tests/worker/pr-scanner.test.js`

- [ ] **Step 1: Add the test**

```javascript
  it('continues to next repo when GitHub returns an error', async () => {
    listProjectsMock.mockReturnValue([
      { id: 'p1', name: 'edms', github_owner: 'EpitechAfrik', github_repo: 'EDMS' },
      { id: 'p2', name: 'zeno', github_owner: 'franckbirba', github_repo: 'zeno' }
    ]);
    octokitListMock.mockImplementation(async ({ owner }) => {
      if (owner === 'EpitechAfrik') {
        const err = new Error('Not Found');
        err.status = 404;
        throw err;
      }
      return { data: [{ number: 1, title: 'z1', body: '', head: { ref: 'b', sha: 's' } }] };
    });
    hasActiveInstanceMock.mockResolvedValue(false);
    enqueueWorkflowStartMock.mockResolvedValue({ ok: true, instance_id: 'i', job_id: 'j' });

    const result = await handlePrScanner({});

    expect(result.projects_scanned).toBe(2);
    expect(result.prs_seen).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ repo: 'EpitechAfrik/EDMS' });
  });
```

- [ ] **Step 2: Run — confirm green**

Run: `npm run test -- tests/worker/pr-scanner.test.js`
Expected: PASS (4/4).

- [ ] **Step 3: Commit**

```bash
git add tests/worker/pr-scanner.test.js
git commit -m "test(pr-scanner): repo error isolation"
```

---

## Task 7: Test — projects without github_owner/repo are skipped

**Files:**
- Modify: `tests/worker/pr-scanner.test.js`

- [ ] **Step 1: Add the test**

```javascript
  it('ignores projects with missing github_owner or github_repo', async () => {
    listProjectsMock.mockReturnValue([
      { id: 'p1', name: 'no-gh', github_owner: null, github_repo: null },
      { id: 'p2', name: 'half',  github_owner: 'foo', github_repo: null },
      { id: 'p3', name: 'ok',    github_owner: 'foo', github_repo: 'bar' }
    ]);
    octokitListMock.mockResolvedValue({ data: [] });

    const result = await handlePrScanner({});

    expect(result.projects_scanned).toBe(1);
    expect(octokitListMock).toHaveBeenCalledTimes(1);
    expect(octokitListMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'foo', repo: 'bar', state: 'open' })
    );
  });
```

- [ ] **Step 2: Run — confirm green**

Run: `npm run test -- tests/worker/pr-scanner.test.js`
Expected: PASS (5/5).

- [ ] **Step 3: Commit**

```bash
git add tests/worker/pr-scanner.test.js
git commit -m "test(pr-scanner): filter projects without github fields"
```

---

## Task 8: Wire the cron entry

**Files:**
- Modify: `src/worker/crons.js`

- [ ] **Step 1: Append a fifth `CRON_JOBS` entry**

Add after the `shelly:morning-digest` entry (before the closing `]`):

```javascript
  ,{
    // PR scanner — replaces the dead GitHub-webhook path. Lists open PRs on
    // every project that has github_owner+github_repo set, dispatches one
    // merge-coordinator per PR. Idempotent via syntheticWorkItemId +
    // workflow_instances unique partial index, so re-runs are safe.
    name: 'pr:scanner',
    data: { agent: 'pr_scanner', source: 'cron', requested_by: 'cron:pr-scanner' },
    repeat: {
      pattern: process.env.PR_SCANNER_CRON || '*/5 * * * *',
      tz: process.env.DEPLOY_TIMEZONE || 'Europe/Paris'
    },
    priority: PRIORITY_MAP.p2
  }
```

- [ ] **Step 2: Run existing crons test (if any) plus the new pr-scanner test**

Run: `npm run test -- tests/worker`
Expected: existing tests still pass; pr-scanner suite still 5/5.

- [ ] **Step 3: Commit**

```bash
git add src/worker/crons.js
git commit -m "feat(crons): register pr:scanner repeatable job (5min)"
```

---

## Task 9: Wire the worker dispatch branch

**Files:**
- Modify: `src/worker/index.js`
- Modify: `src/worker/worktree.js`

- [ ] **Step 1: Add the `pr_scanner` branch in `index.js`**

After the `shelly_digest` branch (around line 260), insert:

```javascript
    if (jobData.agent === 'pr_scanner') {
      const { handlePrScanner } = await import('./handlers/pr-scanner.js');
      return handlePrScanner(jobData);
    }
```

- [ ] **Step 2: Add `'pr_scanner'` to the no-worktree allowlist in `worktree.js`**

Locate the array (currently `['deploy', 'bootstrap', 'shelly_digest']` near line 24) and append `'pr_scanner'`:

```javascript
  'deploy', 'bootstrap', 'shelly_digest', 'pr_scanner'
```

- [ ] **Step 3: Run all worker tests**

Run: `npm run test -- tests/worker`
Expected: PASS — no regression.

- [ ] **Step 4: Commit**

```bash
git add src/worker/index.js src/worker/worktree.js
git commit -m "feat(worker): route pr_scanner agent to handler, no worktree"
```

---

## Task 10: MCP tool `pr_scan` for on-demand scanning

**Files:**
- Modify: `src/mcp/server.js`

- [ ] **Step 1: Locate the `tools` registration block**

Run: `grep -n "tools:" src/mcp/server.js | head -5`
Then read the surrounding code: most MCP tool registrations in this file follow the pattern `server.tool('name', schema, handler)`. Skim the file for the closest neighbour (e.g. `enqueue_job` or `plane_dispatch_work_item`) and copy its style verbatim.

- [ ] **Step 2: Add the `pr_scan` tool next to the other dispatch-related tools**

```javascript
// Near the other tool registrations, e.g. after enqueue_job:
server.tool(
  'pr_scan',
  'Scan all managed projects for open GitHub PRs and dispatch a merge-coordinator workflow for any PR without one. Idempotent — safe to re-run.',
  z.object({}).strict(),
  async () => {
    const { handlePrScanner } = await import('../worker/handlers/pr-scanner.js');
    const summary = await handlePrScanner({});
    return {
      content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }]
    };
  }
);
```

If the file uses a different `server.tool` signature (e.g. an object spec or a registry array), adapt the call shape but keep the handler body identical. Match exactly what the closest sibling tool does.

- [ ] **Step 3: Smoke-test the MCP server starts**

Run: `node -e "import('./src/mcp/server.js').then(() => console.log('ok'))"`
Expected: prints `ok` and exits 0 (no broken-import / zod schema-load failure — the `mcp_zod_record_trap` memory applies if you see a 'tools/list' breakage).

- [ ] **Step 4: Commit**

```bash
git add src/mcp/server.js
git commit -m "feat(mcp): add pr_scan tool for on-demand merge-coordinator dispatch"
```

---

## Task 11: Production smoke test (manual, after deploy)

**Files:** none — operational verification.

- [ ] **Step 1: Push the branch and let CI run, then merge to main**

The `git push` only refreshes the `devpanel` container per `deploy isolation` rule.

- [ ] **Step 2: Verify the cron registered**

Run on services VPS:
```bash
ssh deploy@77.42.46.87 'docker logs devpanel-api --since 5m 2>&1 | grep -i "pr:scanner"'
```
Expected: a line `[Crons] Registered pr:scanner (*/5 * * * *)`.

- [ ] **Step 3: Wait up to 5 minutes for the first scan**

Run:
```bash
ssh deploy@77.42.46.87 'docker logs devpanel-api --since 10m 2>&1 | grep -i "\[pr-scanner\]"'
```
Expected: at least one `dispatched merge-coordinator for EpitechAfrik/EDMS#6 instance=...` line (PR #6 should still be open and unmatched).

- [ ] **Step 4: Verify the workflow_instance landed in pg**

Run:
```bash
ssh deploy@77.42.46.87 'docker exec devpanel-postgres psql -U devpanel -d devpanel -c "SELECT id, work_item_id, current_step, status FROM workflow_instances WHERE workflow_name = '\''merge-coordinator'\'' AND work_item_id LIKE '\''github:%'\'' ORDER BY started_at DESC LIMIT 5;"'
```
Expected: a row with `work_item_id = github:EpitechAfrik/EDMS#6` and `status = running`.

- [ ] **Step 5: Verify idempotence — wait ≥5 min for the next cron tick**

Same query as Step 4. Expected: SAME row, no duplicate. The unique partial index prevents a second insert.

- [ ] **Step 6: Update `MEMORY.md` reference**

The current CLAUDE.md mentions a webhook-based design. Add a one-liner note:

```bash
# Edit /Users/franckbirba/.claude/projects/-Users-franckbirba-DEV-dev-panel/memory/MEMORY.md
# Append: - [PR scanner replaces webhook](pr_scanner.md) — cron */5 polls projects table for open PRs, dispatches merge-coordinator. Webhook code kept dormant for repos where we have admin scope.
```

Then create the memory file with a brief why/how-to-apply.

---

## Self-Review

**Spec coverage** — every requirement from the conversation is addressed:
- Poll PRs from `projects` table source-of-truth → Task 4 (`listProjects().filter(...)`).
- Dispatch `merge-coordinator` per PR → Task 4 (`enqueueWorkflowStart`).
- Idempotent → Task 4 reuses `hasActiveInstance` + `already_running` branch.
- Cron */5 → Task 8.
- Shelly on-demand → Task 10 (MCP tool `pr_scan`).
- All 3 repos covered → naturally, because `listProjects()` returns all rows.

**Placeholder scan** — no TBDs, no "implement later"; every code step shows real code. The MCP tool task (10) has one place I matched-by-pattern instead of dictating the exact registration call shape — flagged inline and the implementer is told to copy the nearest sibling's style.

**Type consistency** — function/property names match across tasks: `handlePrScanner`, `summary.{projects_scanned, prs_seen, dispatched, skipped_active, errors}`, `syntheticWorkItemId(repo, pr.number)`, `enqueueWorkflowStart({workflow, plane, work_item, context})`. Verified against `webhooks-github.js` at `:51-52` and `dispatch.js:40-41`.
