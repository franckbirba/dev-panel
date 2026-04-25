-- 004-dev-bots.sql
-- Multi-tenant Telegram pairing for Shelly.
-- One row per paired bot. The telegram-multi plugin polls SELECT * WHERE
-- status='active' every 30s and spawns one grammy Bot per row.

BEGIN;

CREATE TABLE IF NOT EXISTS dev_bots (
  id                   SERIAL PRIMARY KEY,
  bot_token            TEXT NOT NULL UNIQUE,
  bot_username         TEXT NOT NULL,
  bot_label            TEXT NOT NULL UNIQUE,
  owner_tg_user_id     BIGINT,
  owner_first_name     TEXT,
  paired_by_tg_user_id BIGINT NOT NULL,
  paired_at            TIMESTAMPTZ DEFAULT now(),
  status               TEXT DEFAULT 'active',
  last_inbound_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS dev_bots_status_idx ON dev_bots(status);

COMMIT;
