-- 005-dev-bot-allowlist.sql
-- Move the telegram channel allowlist (formerly access.json on the agents
-- host) into shared Postgres so the API can mutate it at /pair time.
--
-- Seeded by 004 + the boot of the API: every (paired_by_tg_user_id,
-- owner_tg_user_id) referenced by an active dev_bots row should appear here.

BEGIN;

CREATE TABLE IF NOT EXISTS dev_bot_allowlist (
  tg_user_id   BIGINT PRIMARY KEY,
  first_name   TEXT,
  added_at     TIMESTAMPTZ DEFAULT now(),
  added_via    TEXT  -- 'pair' | 'first_inbound' | 'manual'
);

COMMIT;
