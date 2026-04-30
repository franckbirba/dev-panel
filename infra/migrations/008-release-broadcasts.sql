-- 008-release-broadcasts.sql
-- One row per (repo, pr_number, merged) broadcast. Used purely for
-- idempotence: GitHub re-delivers webhook events; we only fan out to
-- the team once per merge.

BEGIN;

CREATE TABLE IF NOT EXISTS release_broadcasts (
  synthetic_id  TEXT PRIMARY KEY,
  broadcast_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
