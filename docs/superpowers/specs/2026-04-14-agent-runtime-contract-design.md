# Agent Runtime Contract + Memory — Design

**Date:** 2026-04-14
**Status:** Draft — pending user review
**Scope:** Spec 1 of 3 (follow-ups: Spec 2 Workflow Engine, Spec 3 Cybersec Agent)

## Problem

The six agent souls under `.agents/` today are abstract role descriptions. When a `claude -p` process is spawned by the BullMQ worker, nothing in the soul tells it:

- which Plane entities it operates on (module / cycle / work-item),
- which MCP tools, skills, and slash commands it may use,
- how to hand off to the next agent,
- how to record what it learned so future agents benefit.

As a result, spawned agents improvise: they miss skills we would want invoked (TDD, verification), bypass MCPs we set up (Plane, Penpot), forget to update status, and never consult or contribute to any shared memory.

Spec 1 defines the runtime contract every agent must obey, the worker-side automation that replaces agent self-reporting, and a pgvector-backed shared memory that agents are obligated to read before work and write to before finishing.

## Out of scope (by design)

Deferred to follow-up specs to keep Spec 1 shippable:

- **Job chains / DAG** (Builder → QA auto-trigger, cycle-end audit, audit-fail replan) → **Spec 2**
- **Cybersec auditor agent** → **Spec 3**
- **Shelly Telegram bot commands** (`/deploy`, `/status`, digest reports) → later spec; authorization model is in place so additive
- **Memory pruning / TTL enforcement** → later (schema ready via `expires_at`)

## 1. Plane taxonomy as the canonical ontology

All agents, all jobs, all worker logs speak Plane's vocabulary. No ad-hoc "task / ticket / feature" synonyms.

- **Module** — bounded feature or subsystem (e.g. "Auth rewrite").
- **Cycle** — timeboxed sprint with start/end dates.
- **Work-item** — atomic unit of work; what a job operates on.
- **States** — Plane state machine: `backlog` → `todo` → `in_progress` → `done` | `cancelled` | `blocked`.

Every job payload carries `(module_id, cycle_id, work_item_id)`. GitHub issues, devpanel tickets, and memory entries all include the same triple so cross-references are trivial.

**Authority:** PM is the only agent that creates or modifies modules and cycles. All other agents consume them.

## 2. Job input and output contract

### 2.1 Input payload (BullMQ → worker → `claude -p`)

```json
{
  "job_id": "job_abc123",
  "agent": "builder",
  "mode": "autonomous | collaborative",
  "plane": {
    "module_id": "mod_...",
    "cycle_id": "cyc_...",
    "work_item_id": "wi_..."
  },
  "work_item": {
    "title": "...",
    "description": "...",
    "acceptance_criteria": ["...", "..."],
    "priority": "p0|p1|p2|p3"
  },
  "context": {
    "branch": "feat/wi_xxx-short-desc",
    "github_issue_number": 42,
    "devpanel_ticket_id": "tkt_...",
    "parent_job_id": null,
    "previous_agent_output": null
  },
  "required_skills": ["superpowers:test-driven-development", "shared-memory"],
  "allowed_mcp": ["devpanel", "plane"],
  "memory_namespace": "dev-panel"
}
```

### 2.2 Output contract

The **last line** of agent stdout MUST be valid JSON matching this shape, with no text after it:

```json
{
  "status": "done | blocked | failed",
  "summary": "one-sentence French summary",
  "artifacts": {
    "files_created": [],
    "files_modified": [],
    "commits": ["sha1", "sha2"],
    "branch": "feat/wi_xxx-...",
    "tests_passed": true,
    "pr_url": null
  },
  "handoff": {
    "next_agent": "reviewer | null",
    "reason": "..."
  },
  "memory_writes_count": 3,
  "blockers": [],
  "issues_found": []
}
```

### 2.3 Parse failure policy

If stdout contains no JSON object on its last line, or the JSON fails schema validation, the worker marks the job `failed`, logs the raw stdout to `agent_job_log`, notifies Shelly, and does not run any downstream automation. No silent failures.

## 3. Worker-side automation matrix

When `claude -p` exits, `src/worker/index.js` runs this sequence. Each step is wrapped in try/catch and recorded as a row in `agent_job_log (job_id, step, status, error, duration_ms, timestamp)`. A failure in step N does not block step N+1.

| # | Step | Trigger condition |
|---|---|---|
| 1 | `parseResult(stdout)` | Always |
| 2 | `plane.update_work_item` | Always — `in_progress` on start, `done` / `blocked` / `failed` on finish |
| 3 | `github.issue_sync` | `agent=pm` → create issue on dispatch; `agent=reviewer && status=done` → close with PR link. No other events touch GitHub. |
| 4 | `devpanel.update_ticket` | If work-item originated from a ticket, mirror status |
| 5 | `shelly.notify` | One Telegram line per job (5s debouncer) |
| 6 | `memory.verify_writes` | Audit-only: confirm `memory_writes_count` matches rows actually inserted during the job (via `agent_job_log` tracking of MCP calls). Worker does NOT auto-embed code; embedding happens inside `memory_write` MCP calls made by the agent. |
| 7 | `workflow.trigger_next` | Stub in Spec 1 — logs `handoff.next_agent`. Activated in Spec 2. |

### 3.1 Credential hygiene

All API keys (Plane token, GitHub token, Voyage key, Telegram bot token) live in the worker's env. They are **never** injected into the `claude -p` sandbox. Agents only see MCP tools, which call back into the worker's authenticated context.

## 4. Memory layer — pgvector + Voyage

### 4.1 Infra change

In `infra/docker-compose.yml`: swap the existing `postgres:16-alpine` image to `pgvector/pgvector:pg16`. The AFFiNE database is untouched; a second database `agent_memory` is added:

```sql
CREATE EXTENSION vector;

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

CREATE INDEX ON memories USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX ON memories (namespace, agent, kind);
CREATE INDEX ON memories (module_id, cycle_id, work_item_id);
```

`kind` vocabulary: `decision`, `debug_finding`, `spec_note`, `handoff`, `retrospective`, `audit_finding` (reserved for Spec 3).

### 4.2 Embeddings

- Provider: Voyage AI, model `voyage-code-3` (1024 dims, code-tuned).
- Volume budget at Franck's real churn: ~2–5M tokens/month, under $1.50/month.
- Helper: `src/server/voyage.js`. Key in `.env` as `VOYAGE_API_KEY`.
- All embedding calls happen server-side; agents never see the key.

### 4.3 MCP tools added to `src/mcp/server.js`

- `memory_search({ query, kind?, agent?, module_id?, limit=5 })` — embed query via Voyage, pgvector cosine similarity, SQL filters, returns top-K with scores.
- `memory_write({ kind, title, content, tags?, module_id?, cycle_id?, work_item_id? })` — worker embeds content, inserts row, returns id.
- `memory_list({ kind?, agent?, module_id?, limit=20 })` — non-semantic listing, used for retros and debugging.

### 4.4 `shared-memory` skill (mandatory for all agents)

Written to `.claude/skills/shared-memory.md`. Enforces:

1. **Before starting work:** call `memory_search(work_item.title + description, module_id)` and review top 5 results.
2. **During work:** call `memory_search` whenever facing a non-trivial decision — "has this been decided before?"
3. **Before emitting final JSON:** call `memory_write` for each: non-obvious decision, debug finding, handoff note. `memory_writes_count` in output must match writes performed.
4. **Do not write:** restatements of the code (git diff has it), task acks, trivial "done" notes.

Each soul declares `memory_kinds_authored: [...]` restricting which `kind` values its writes may use. Worker rejects `memory_write` calls with a kind not in the agent's allowlist.

## 5. SOUL template

Every soul under `.agents/<role>/SOUL.md` uses the same sections, in order. Each section is mandatory.

```markdown
# <Agent> Agent

## Identity
Role, tone, language. One paragraph max.

## Mission
The ONE sentence defining why this agent exists. If it does not fit in one
sentence, the role is fuzzy.

## You MUST
Hard rules, numbered. Each rule references a concrete tool, skill, or command.

## You MUST NOT
Hard prohibitions, numbered.

## Skills (mandatory)
Skills this agent MUST invoke by name, in order of usage.

## MCP tools (allowed)
Explicit allowlist. If not listed, do not use.

## Slash commands (preferred)
/commit, /review-pr, etc., as applicable.

## Input
Names the fields of §2.1 that are load-bearing for this role.

## Output
Names the fields of §2.2 this agent must populate.

## Handoff
Who gets the baton on done / on blocker. Drives handoff.next_agent.

## Memory policy
memory_kinds_authored: [...]
search_required_before: true
write_required_after: true
```

Each soul has a companion `.agents/<role>/PLAYBOOK.md` that links to the existing `.claude/skills/agent-<role>.md` skill (already detailed, reused not rewritten) plus any role-specific runbook content that would clutter the soul.

### 5.1 The seven souls (six existing + deploy)

| Agent | Mission (one sentence) | Handoff on done |
|---|---|---|
| PM | Own the roadmap: translate Franck's intent into Plane modules, cycles, work-items; create GitHub issues on dispatch. | → architect (if design needed) or → builder |
| Architect | Produce ADRs for decisions crossing module boundaries or changing invariants; review before complex features. | → pm or → builder |
| Designer | Produce Penpot specs (tokens, components, states) that Builder can consume without guessing. | → builder |
| Builder | Implement the work-item on a feature branch with tests that prove acceptance criteria; commit, do not merge. | → reviewer |
| Reviewer | Validate builder's branch against tests and conventions; merge in autonomous mode, report in collaborative mode. | → qa (on merge) or → builder (on reject) |
| QA | After merge: full test suite + build + edge cases on main; raise blockers back to PM. | → pm (on blocker) or terminal |
| Deploy | Execute the deploy runbook on the services node: build, push, deploy profile. | terminal |

The **Cybersec** agent is deferred to Spec 3.

## 6. Shelly notifications (MVP)

One Telegram line per job, rate-limited by a 5-second debouncer. Plain ASCII, no emojis. Status markers: `DONE`, `BLOCKED`, `FAILED`, `APPROVED`, `REJECTED`.

```
[builder]  wi_a1b2 "fix login flow"  DONE  (12s, 3 commits)     next: reviewer
[reviewer] wi_a1b2  APPROVED, merged to main                    next: qa
[qa]       wi_a1b2  FAILED  (2 tests failing)                   next: pm
[deploy]   nightly build 2026-04-14  DONE  (image pushed)       next: -
```

`job_id` is carried as a hidden Telegram comment so later bot commands can reference it. Implemented via a new helper `alerts.notifyJob(job, result)` in the existing `src/server/alerts.js`, called as step 5 of the automation matrix.

## 7. Dashboard live updates (SSE)

The dashboard currently has no refresh path. Spec 1 adds:

- `GET /api/events` — Server-Sent Events endpoint in `src/server/routes.js`, streaming:
  - `job.started { job_id, agent, work_item_id }`
  - `job.step { job_id, step, status }`
  - `job.finished { job_id, status, summary }`
  - `ticket.updated { ticket_id, status }`
  - `memory.written { id, agent, kind, title }`
- Worker publishes events to an in-process `EventEmitter` that fans out to all SSE clients.
- Dashboard (`src/dashboard/*`) subscribes on mount; job, ticket, and queue panes update reactively on event receipt.
- BullBoard already gives queue visibility in real-time; SSE covers devpanel-native views.

No polling, no websockets. SSE survives Traefik unchanged.

## 8. Deploy workflow

Deploy is a job type, uniform with other agents.

- **Handler:** new `src/worker/handlers/deploy.js`.
- **Skill used:** existing `stack-deploy.md`. Not rewritten.
- **Soul:** new `.agents/deploy/SOUL.md`. Thin, deterministic, no brainstorming/TDD skills — deploy is a runbook, not exploratory work.
- **Authorization (worker-enforced):** `allowed_requesters: ["franck", "cron:nightly"]`. Any other `requested_by` is rejected before `claude -p` spawns. Even PM cannot enqueue a deploy.
- **Triggers:**
  1. **Nightly cron** at 03:00 Europe/Paris on the services node. Runs `stack-status` first; bails if unhealthy. Otherwise builds, pushes the image, deploys core profile.
  2. **Ad-hoc via Franck**: `devpanel deploy` CLI immediately; later, Shelly Telegram `/deploy` command (deferred spec, authorization already covers it).
- **Output contract** is the standard §2.2 JSON.
- **Notifications:** Shelly line on start and on finish, including the image tag deployed.

## 9. Rollout order

Each step independently testable; no step leaves the system in a half-done state.

1. **Infra** — pgvector image swap, `agent_memory` DB migration, `VOYAGE_API_KEY` env, nightly deploy cron entry.
2. **Memory MCP tools** — `voyage.js` helper, `memory_search` / `memory_write` / `memory_list`, `agent_job_log` table.
3. **Worker automation** — strict `parseResult`, automation matrix, deploy handler with authorization gate, SSE `EventEmitter`.
4. **Dashboard live updates** — `/api/events` SSE endpoint, dashboard subscribes, panes react.
5. **`shared-memory` skill** — `.claude/skills/shared-memory.md`.
6. **SOUL rewrites** — 7 files (`pm`, `architect`, `designer`, `builder`, `reviewer`, `qa`, `deploy`), PLAYBOOK companions linking to existing `agent-*` skills.
7. **Smoke test** — dispatch one work-item through PM → Builder → Reviewer → QA. Verify:
   - every automation row in `agent_job_log`,
   - memory entries written and retrievable via `memory_search`,
   - Shelly Telegram received one line per agent transition,
   - dashboard updates live without refresh.
   Then trigger a nightly-simulated deploy with `requested_by: franck`, verify the Shelly deploy line and image tag appear.

## 10. Risks and mitigations

- **Voyage outage.** `memory_search` / `memory_write` fail. Mitigation: treat embedding calls as non-blocking — degrade to metadata-only search (SQL LIKE on title/tags) and queue pending embeds for retry. Memory policy stays enforced; only quality degrades temporarily.
- **pgvector migration on live AFFiNE DB.** Swapping the image could surprise AFFiNE. Mitigation: stop AFFiNE, snapshot the `postgres-data` volume, swap image, start, verify AFFiNE schema intact before creating `agent_memory`.
- **Agents emit invalid JSON.** Handled by §2.3 — job marked failed, no silent automation. Over time, soul revisions tighten the contract.
- **Shelly notification flood.** 5-second debouncer is the MVP safety net. If noise becomes unworkable before the follow-up Shelly spec ships, raise the debouncer window.
- **Nightly deploy on bad state.** `stack-status` precheck bails the deploy; Shelly notified with the failing service list.

## 11. Next step

Once approved, proceed to writing-plans to produce the step-by-step implementation plan for this spec.
