# Workflow Engine — Design

**Date:** 2026-04-14
**Status:** Draft — pending user review
**Scope:** Spec 2 of 3 (follow-up: Spec 3 Cybersec Agent)
**Depends on:** Spec 1 (Agent Runtime Contract + Memory), merged 2026-04-14.

## Problem

Spec 1 shipped the agent runtime contract and shared memory. Every agent now emits a structured JSON result with a `handoff.next_agent` hint, and the worker's automation matrix runs six post-exit steps plus a seventh stub — `workflow.trigger_next` — that only logs what it *would* chain to:

```js
// src/worker/automation.js
logStep({ job_id, agent, step: 'workflow.trigger_next', status: 'stub',
          error: result.handoff?.next_agent ? `would chain to ${result.handoff.next_agent}` : null });
```

Today a pipeline still needs a human to re-dispatch every next step. There is no concept of a workflow, no re-entrant state for work-items that need more than one pass, and no mechanism to trigger cycle-end audits or replan loops. Spec 2 replaces the stub with a workflow engine that owns three things:

1. Declarative workflow definitions (YAML), loaded at worker boot.
2. Per-`(work_item_id, workflow_name)` re-entrant instance state in agents-node SQLite.
3. A `triggerNext` implementation that replaces the Spec 1 stub, enqueues downstream jobs, and governs replan loops.

## Out of scope (by design)

Deferred to Spec 3 to keep Spec 2 shippable:

- **Cybersec auditor agent.** The `cycle-audit` workflow references a not-yet-implemented `audit` agent on purpose — when Spec 3 arrives, it plugs into the stable engine contract with no engine changes.
- **Telegram `/deploy`, `/status`, digest commands.** Still later-spec work; unchanged by Spec 2.
- **Memory pruning / TTL enforcement.** Same deferral as Spec 1.
- **Workflow authoring UI.** YAMLs are code-versioned in-repo; no runtime editor.

## 1. Topology: hybrid declarative with retreat-only overrides

Spec 1's JSON contract includes `handoff.next_agent`, an agent-level signal. Spec 2 layers declarative YAML workflows on top, but does NOT discard the agent hint. The rule:

- **Forward progress is engine-owned.** The YAML declares the pipeline path. Agents cannot skip steps.
- **Retreats are agent-owned within a narrow allowlist.** Reviewer can send back to builder; QA can send back to PM. Each step declares `retreat_allowed: [...]`, and any `handoff.next_agent` outside that list is rejected (logged as `retreat_rejected`) — the declared transition fires instead.

This preserves the local knowledge Spec 1 invested in (reviewer rejecting a PR mid-pipeline) while preventing the class of improvisation that motivated Spec 1 in the first place (agents skipping TDD or verification by "deciding" the next step).

## 2. Workflow definitions — YAML in-repo

Three workflows ship in Spec 2, one file each under `src/worker/workflows/`.

### 2.1 `work-item.yaml`

Standard work-item pipeline.

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

### 2.2 `cycle-audit.yaml`

Cycle-end audit. The `audit` agent itself arrives in Spec 3; the engine wiring is Spec 2's responsibility.

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

### 2.3 `replan.yaml`

Single-step PM workflow used when other workflows route back to PM.

```yaml
name: replan
description: PM re-plans a failed workflow revision.
max_revisions: 1
on_exhaustion: block

steps:
  - agent: pm
    on:
      done:     { terminal: true }   # engine resumes parent workflow at revision+1
      blocked:  { terminal: true }   # parent stays awaiting_approval
      failed:   { terminal: true }
```

### 2.4 YAML rules

- `when:` values reference a predicate function by name from `src/worker/predicates.js`. Unknown names fail worker boot.
- `workflow: replan` on a transition means "enqueue a replan pipeline on this work-item; on replan completion, bump parent revision and restart the parent's first step".
- `terminal: true` ends the instance. Combined with `on_exhaustion`, every path has a defined end.
- `retreat_allowed` is optional; absent means no retreat.

## 3. Data model — `workflow_instances` (agents-node SQLite)

Co-located with `agent_job_log` (Spec 1). Owned by `src/server/workflow-instances.js`.

```sql
CREATE TABLE workflow_instances (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id    TEXT NOT NULL,
  workflow_name   TEXT NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 1,
  current_step    TEXT NOT NULL,
  status          TEXT NOT NULL,
  module_id       TEXT,
  cycle_id        TEXT,
  started_at      INTEGER NOT NULL,
  last_event_at   INTEGER NOT NULL,
  exhausted_at    INTEGER,
  last_job_id     TEXT,
  metadata        TEXT
);

CREATE UNIQUE INDEX idx_wi_workflow_active
  ON workflow_instances(work_item_id, workflow_name)
  WHERE status IN ('running', 'awaiting_approval');

CREATE INDEX idx_wi_status ON workflow_instances(status);
CREATE INDEX idx_wi_cycle  ON workflow_instances(cycle_id);
```

### 3.1 `status` vocabulary

- `running` — at least one job enqueued, none terminal yet.
- `awaiting_approval` — routed to PM for replan; parent pipeline is paused.
- `done` — reached a terminal branch successfully.
- `blocked` — an agent emitted `blocked`, routed to replan, but replan itself returned `blocked` or failed.
- `failed` — engine hit an irrecoverable error (queue add failure, missing result JSON, YAML evaluation error).
- `exhausted` — revision cap hit; `on_exhaustion: block` applied.

### 3.2 `current_step`

Set to the agent name of the *last dispatched* job, not the last completed one. This lets the dashboard show "wi_abc is at builder, waiting" during a long-running job.

### 3.3 Unique partial index

Enforces the concurrency rule: at most one non-terminal instance per `(work_item_id, workflow_name)`. Duplicate dispatch attempts get a SQLite constraint error that `enqueueWorkflowStart` converts into a clean "already running, ignored" log line. Idempotency comes from the DB, not from the code path.

### 3.4 `metadata` column

JSON blob, workflow-specific. Holds: previous revision's `issues_found` + `blockers` for replan, audit severity summary for cycle-audit, free-form notes added via admin CLI. Keeps the schema stable when new workflows ship.

## 4. Engine logic — `triggerNext(jobData, result)`

Lives in `src/worker/engine.js`. Called as step 7 of `runAutomation`.

```
1. If jobData.workflow is absent, log 'no-workflow' and return.
   (One-off jobs — deploy, ad-hoc dispatch — are preserved.)

2. Load workflow YAML by name. Missing → instance 'failed', Shelly alert.

3. Load workflow_instance row by (work_item_id, workflow_name).
   Missing → create it (this job was the first step).

4. Find current step: yaml.steps.find(s => s.agent === jobData.agent).

5. Pick transition branch from step.on[result.status].
   Missing branch → log warning, mark instance 'failed'.

6. If branch.when is set, evaluate predicates[branch.when](result, jobData).
   False → try next declared branch; if none, treat as terminal.

7. Validate handoff.next_agent against step.retreat_allowed:
   - In allowlist → override branch.next, log 'retreat_override'.
   - Out of allowlist → log 'retreat_rejected', use declared transition.
   Agent hints are never blocking.

8. Apply the action:
   - branch.terminal: mark instance with status matching result.status
     (done | blocked | failed), emit workflow.finished. If this instance
     is a replan (i.e., it has parent_instance_id in metadata), also run
     the parent-resume logic below.
   - branch.workflow === 'replan': enqueue replan job with parent_instance_id
     in its payload, mark current (parent) instance 'awaiting_approval'.
   - branch.next: if revision < max_revisions, enqueue next agent.
     Else apply on_exhaustion.

Parent-resume logic (when a replan instance reaches terminal):
   - result.status === 'done': parent revision += 1, re-enqueue parent's
     first step with amended acceptance criteria from PM output, parent
     status back to 'running'.
   - result.status === 'blocked' or 'failed': parent stays 'awaiting_approval',
     Shelly alert with replan's reason. Franck unblocks manually.

9. Order of state changes: queue.add → instance update → SSE emit.
   Queue.add failure aborts before any state changes; later failures
   self-heal on the next triggerNext call.
```

### 4.1 Replan job payload

When a workflow routes to `pm / replan`, the PM job receives:

- `parent_workflow` — name of the workflow that triggered replan.
- `parent_revision` — revision that failed.
- `parent_instance_id` — SQLite row id of the paused parent.
- `failed_step` — agent whose result triggered replan.
- `issues_found`, `blockers` — from the failed job's output JSON.
- `previous_memory_keys` — top-K `memory_search` hits from prior revisions of this work-item, so PM can see what was already tried.

### 4.2 `on_exhaustion` actions

- `block` — instance → `exhausted`, work-item → `blocked` in Plane, Shelly alert lists revisions consumed. No auto-dispatch.
- `escalate` — reserved enum for future Telegram-button escalation; Spec 2 logs it as equivalent to `block` until Shelly bot commands ship.
- `continue` — rare; logged at warn, pipeline proceeds. Not used by any Spec 2 workflow.

### 4.3 Predicate registry

`src/worker/predicates.js` exports a `predicates` object keyed by name. Each predicate is a pure function `(result, jobData) => boolean`. Spec 2 ships with:

- `reviewer_rejected_pr` — true when `result.issues_found` contains at least one `severity >= 'p1'` entry.
- `qa_infra_only` — true when all entries in `result.blockers` have `kind === 'infra'`; used by the infra-retry mitigation (§10).

Worker boot validates every `when:` reference against this registry; missing names abort boot.

## 5. Dispatch entry points

Three callers can *start* a workflow instance.

### 5.1 PM agent — `plane.dispatch_work_item`

New MCP tool. Parameters: `work_item_id`, optional `workflow` (default `work-item`). Delegates to `enqueueWorkflowStart`.

### 5.2 PM agent — `plane.close_cycle`

New MCP tool. Marks the cycle closed in Plane **and** enqueues a scheduled `cycle-audit` job for that cycle. Scheduling uses BullMQ's `{ delay }` option; default target is the next 09:00 Europe/Paris. The cycle closure itself is lightweight — one Plane write plus one queue add. No inline audit.

Reopening a cycle does NOT auto-cancel the scheduled audit; PM runs an explicit `plane.cancel_audit(cycle_id)` if needed. Audits are precious, not chore-work.

### 5.3 Admin CLI — `devpanel workflow dispatch`

Operator override. Same code path as PM dispatch, authenticated by the admin key.

### 5.4 Shared helper — `enqueueWorkflowStart`

Used by all three entry points. Atomically:

1. Insert `workflow_instance` row (status `running`, revision 1, `current_step = steps[0].agent`).
2. `queue.add(...)` with the enriched payload.
3. Emit `workflow.started` SSE event.

If the unique index rejects step 1, the helper returns `{ error: 'already_running' }`; callers (MCP tools, CLI) surface that cleanly to PM / Franck.

## 6. Job payload extension

Spec 1's §2.1 payload gets three optional fields:

```json
{
  "job_id": "...",
  "agent": "builder",
  "workflow": "work-item",
  "workflow_instance_id": 42,
  "workflow_revision": 1,
  "plane": { "module_id": "...", "cycle_id": "...", "work_item_id": "..." },
  "work_item": { ... },
  "context": { ... },
  "required_skills": [...],
  "allowed_mcp": [...],
  "memory_namespace": "dev-panel"
}
```

Jobs without `workflow` are one-offs — deploy, ad-hoc dispatch, any Spec 1-era call path. The engine's `triggerNext` returns early on those. No existing code path breaks.

## 7. SOUL touch-ups

Minimal. Spec 1's SOULs already declare `handoff.next_agent`.

- **Reviewer SOUL:** adds `handoff.retreat_allowed: [builder]` as a declared capability; soul text mentions that rejection routes back to builder.
- **QA SOUL:** adds `handoff.retreat_allowed: [pm]`.
- **PM SOUL:** gains a "Replan mode" section. When receiving a job with `parent_workflow` set, PM's mission is narrower — consume `issues_found` + prior memory, emit amended acceptance criteria, do NOT redo full cycle planning.

No other SOUL changes. The audit agent's SOUL lands in Spec 3.

## 8. Dashboard — Pipelines pane

Reuses Spec 1's SSE plumbing (`src/dashboard/lib/events.js`). Three new event types published through the existing `/api/admin/events/publish` channel:

- `workflow.started { instance_id, work_item_id, workflow, revision }`
- `workflow.transitioned { instance_id, from_agent, to_agent, reason }`
- `workflow.finished { instance_id, status }`

New "Pipelines" pane on the Queues view: active `workflow_instances` grouped by cycle, live-updating. Terminal instances fade after 30s. Failed instances persist until acked from the UI.

API additions in `src/server/routes.js`:

- `GET /api/admin/workflows/instances?status=running|awaiting_approval&cycle_id=...`
- `GET /api/admin/workflows/instances/:id` — instance + full `agent_job_log` join.

Pure frontend work once the API endpoints land.

## 9. Testing strategy

### 9.1 Unit (vitest, no integrations)

`src/worker/engine.test.js` covers:

- YAML loading (valid, invalid, missing predicate refs → boot abort).
- Transition evaluation: every declared branch across all three workflows has an enumerated test.
- Retreat allowlist: in-list → override applied; out-of-list → declared transition wins.
- Revision guard: at `max_revisions`, `on_exhaustion: block` fires instead of enqueue.
- Predicate registry: each predicate has its own focused test.
- Concurrent instance: unique-index collision handled cleanly.
- Replan flow: parent → replan → parent revision bump.

Mocks: `queue.add` is a spy; SQLite runs in-memory via `better-sqlite3`.

### 9.2 Integration (opt-in)

`scripts/smoke-workflow-engine.sh` — two scenarios against real SQLite + BullMQ + Redis:

1. **Happy path.** Synthetic `work-item` pipeline with pre-canned agent stdout. Assert: three jobs fire in order, instance ends `done`, three `agent_job_log` rows, three `workflow.transitioned` SSE events.
2. **Replan path.** QA stdout declares `status: failed`. Assert: PM replan enqueued, instance `awaiting_approval`, PM stdout `done` bumps revision, pipeline restarts at builder. Bail on revision > cap.

No Plane/GitHub/Voyage needed — those automation steps no-op without creds, per Spec 1 design.

### 9.3 TDD discipline

Engine is TDD'd per repo convention. Test file is the first commit of the engine module.

### 9.4 Live dogfood

After ship, dispatch a real Plane work-item through the live worker on the agents node. Validate: instance row created, chain executes, memory writes visible, dashboard pane updates, Shelly lines fire per transition. Not a regression suite — one-shot validation that the pipeline eats its own food.

## 10. Risks and mitigations

1. **Stuck `awaiting_approval` instances.** PM never finishes → parent sits forever. → Nightly cron lists instances in `awaiting_approval` older than 48h and Shelly-alerts. No auto-timeout; human-in-the-loop is deliberate.
2. **YAML drift from code.** Predicate rename silently breaks a workflow. → Boot-time validation of the predicate reference graph. Predicate tests assert every exported name is referenced by at least one YAML (dead-predicate check).
3. **Replan loops on flaky infra.** Transient QA failures burn revisions. → QA SOUL distinguishes infra from code (`blockers[].kind: 'infra'`); `qa_infra_only` predicate routes to a simple retry instead of replan.
4. **Dual dispatch race.** Franck + PM enqueue simultaneously. → SQLite unique partial index rejects the second; idempotency lives in the DB.
5. **New agent forgotten in workflows.** Spec 3's audit agent lands without YAML wiring. → Caught by Spec 3's own smoke test; one-off agents without workflow refs are a soft failure by design.
6. **Scheduled cycle-audit misfires.** Cycle reopens between close and fire. → `enqueueWorkflowStart` is idempotent per `cycle_id`; reopening does not auto-cancel — PM runs `plane.cancel_audit` explicitly.
7. **`engine.js` becomes a god-module.** → Soft ceiling of ~200 lines; predicates, instance storage, dispatch are already separate modules. New concerns graduate to new files.
8. **Transition boundary state drift.** `queue.add` + instance update + SSE can partially fail. → Strict ordering: queue.add first (most likely to fail), instance update second, SSE last. Queue-add failure aborts cleanly; later failures self-heal on the next `triggerNext` call.

## 11. Rollout order

Each step independently testable; system stays working throughout (engine is additive).

1. **Schema & storage.** `workflow_instances` table + `src/server/workflow-instances.js` + vitest coverage. Migration in `infra/migrations/`.
2. **Workflow loader + predicate registry.** `src/worker/engine.js` (loader only) + `src/worker/predicates.js`. Three YAMLs written; boot fails fast on invalid YAML or unknown predicates.
3. **`triggerNext` engine logic.** Pure transition evaluator, retreat enforcement, revision guard, `on_exhaustion` handling. Not yet wired. Exhaustive branch-coverage tests.
4. **Wire engine into `runAutomation`.** Replace the Spec 1 stub. Add payload fields. Backward-compatible: missing `workflow` is a no-op.
5. **Dispatch entry points.** `enqueueWorkflowStart` + `plane.dispatch_work_item` + `plane.close_cycle` + `devpanel workflow dispatch`. Tests: happy path + duplicate dispatch + scheduled audit.
6. **Dashboard Pipelines pane.** New SSE event types; new admin API endpoints; frontend pane.
7. **SOUL touch-ups.** Reviewer, QA, PM.
8. **Smoke script.** `scripts/smoke-workflow-engine.sh`.
9. **Live dogfood.** Dispatch a real work-item through the live worker.

**Plane taxonomy:** module `Workflow Engine (Spec 2)` on project `devpanl`. Reuse the active Sprint cycle if one exists; else create a two-week cycle ending mid-May.

**Spec 3 readiness:** after step 4, the `cycle-audit` YAML references a not-yet-implemented `audit` agent. Dispatching one fails cleanly with "agent not implemented" — Spec 3 arrives, adds the SOUL + PLAYBOOK + MCP tool, no engine changes needed.

## 12. Next step

Once approved, proceed to `superpowers:writing-plans` to produce the step-by-step implementation plan for this spec.
