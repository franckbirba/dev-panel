-- 003-orchestration-pg.sql
-- Move orchestration state (workflow_instances, agent_job_log, agent_job_events,
-- agent_memory_writes) from the per-host SQLite master.db to the SHARED Postgres
-- on the services node. Root cause being fixed: the worker runs on the agents
-- host and wrote to its local SQLite, but the dashboard reads from the services
-- host SQLite — two disconnected files, so the dashboard always saw zero jobs.
--
-- Applied on the same `agent_memory` database that already hosts the pgvector
-- `memories` table (shared between hosts via 10.0.0.2:5432).

BEGIN;

CREATE TABLE IF NOT EXISTS workflow_instances (
  id              BIGSERIAL PRIMARY KEY,
  work_item_id    TEXT NOT NULL,
  workflow_name   TEXT NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 1,
  current_step    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running',
  module_id       TEXT,
  cycle_id        TEXT,
  started_at      BIGINT NOT NULL,
  last_event_at   BIGINT NOT NULL,
  exhausted_at    BIGINT,
  last_job_id     TEXT,
  metadata        JSONB
);

-- Only one active (running/awaiting_approval) instance per (work_item, workflow).
-- Matches the SQLite partial unique index semantics.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wi_workflow_active
  ON workflow_instances(work_item_id, workflow_name)
  WHERE status IN ('running', 'awaiting_approval');
CREATE INDEX IF NOT EXISTS idx_wi_status ON workflow_instances(status);
CREATE INDEX IF NOT EXISTS idx_wi_cycle  ON workflow_instances(cycle_id);
CREATE INDEX IF NOT EXISTS idx_wi_last_event ON workflow_instances(last_event_at DESC);

CREATE TABLE IF NOT EXISTS agent_job_log (
  id           BIGSERIAL PRIMARY KEY,
  job_id       TEXT NOT NULL,
  agent        TEXT NOT NULL,
  step         TEXT NOT NULL,
  status       TEXT NOT NULL,
  error        TEXT,
  duration_ms  INTEGER,
  timestamp    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ajl_job  ON agent_job_log(job_id);
CREATE INDEX IF NOT EXISTS idx_ajl_time ON agent_job_log(timestamp DESC);

CREATE TABLE IF NOT EXISTS agent_job_events (
  id            BIGSERIAL PRIMARY KEY,
  job_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  event_type    TEXT NOT NULL,
  event_subtype TEXT,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_aje_job_seq ON agent_job_events(job_id, seq);
CREATE INDEX IF NOT EXISTS idx_aje_created ON agent_job_events(created_at DESC);

CREATE TABLE IF NOT EXISTS agent_memory_writes (
  job_id     TEXT NOT NULL,
  memory_id  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, memory_id)
);

COMMIT;
