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
