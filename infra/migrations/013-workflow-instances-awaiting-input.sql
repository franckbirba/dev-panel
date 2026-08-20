-- 013-workflow-instances-awaiting-input.sql
-- Engine contract §3.2 / §9 — the "live" instance states are
-- running · awaiting_approval · awaiting_input, but the unique partial
-- index from 002/003 only ever covered running/awaiting_approval. A work
-- item stuck in awaiting_input (blocked, waiting on a human via the
-- await_human MCP tool) could therefore be double-dispatched — the exact
-- gap §9 calls out: idempotence must block a duplicate dispatch on ANY
-- live state, not just two of the three.
--
-- Postgres has no ALTER INDEX ... to change a partial index's predicate;
-- drop + recreate under the same name is the standard path. Both statements
-- are safe to run multiple times (idempotent) and take a lock briefly
-- (workflow_instances is small — this is not a hot-path bulk table).

BEGIN;

DROP INDEX IF EXISTS idx_wi_workflow_active;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wi_workflow_active
  ON workflow_instances(work_item_id, workflow_name)
  WHERE status IN ('running', 'awaiting_approval', 'awaiting_input');

COMMIT;
