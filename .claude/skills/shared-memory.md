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
