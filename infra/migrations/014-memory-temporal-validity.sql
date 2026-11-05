-- 014-memory-temporal-validity.sql
-- Add temporal validity windows to memories and subject_links tables.
-- 
-- This migration adds valid_from/valid_to columns to support temporal validity:
-- - valid_from: when the fact became true (default: created_at)
-- - valid_to: when the fact ceased to be true (NULL = still valid)
--
-- memory_search and memory_list exclude expired facts by default.
-- An optional as_of parameter can query historical states.

BEGIN;

-- Add temporal validity columns to memories table (PostgreSQL)
ALTER TABLE memories 
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ;

-- Set valid_from to created_at for existing rows
UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL;

-- Add indexes for efficient temporal queries
CREATE INDEX IF NOT EXISTS memories_validity_window 
  ON memories (valid_from, valid_to);
CREATE INDEX IF NOT EXISTS memories_namespace_validity 
  ON memories (namespace, valid_from, valid_to);

-- Add temporal validity columns to subject_links table (SQLite)
-- Note: SQLite ALTER TABLE is limited, so we need to recreate the table
-- This is done in the application code via db.js schema updates

COMMIT;