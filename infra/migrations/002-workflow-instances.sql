-- 002-workflow-instances.sql
-- Workflow engine (Spec 2): per-work-item workflow state.
-- Applied by hand on the agents-node SQLite master db.
-- Fresh worktrees get this via `CREATE IF NOT EXISTS` in src/server/db.js.

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
