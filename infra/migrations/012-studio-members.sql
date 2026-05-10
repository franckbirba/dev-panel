-- 012-studio-members.sql
-- Studio-wide identity + capability + destination, one row per human.
-- Replaces three ad-hoc concepts:
--   - dev_bot_allowlist (kept for pairing, not for authz).
--   - Hardcoded tg_user_id=5663177530 Franck checks across SOUL.md and source.
--   - "Lean on Plane membership" authz fantasy.
--
-- Spec: docs/superpowers/specs/2026-05-09-agent-interactivity-v2-design.md (Step 3)
--
-- Used by:
--   - HITL routing (Step 5 notifyEvent picks the right tg_chat_id per event).
--   - Authz on tool_approval (can_deploy gates `agent=deploy` actions).
--   - The adapter whitelist filter in telegram-multi (Step 4).

BEGIN;

CREATE TABLE IF NOT EXISTS studio_members (
  tg_user_id          BIGINT PRIMARY KEY,
  display_name        TEXT NOT NULL,
  bot_label           TEXT,
  projects            TEXT[] NOT NULL DEFAULT '{}',
  roles               TEXT[] NOT NULL DEFAULT '{}',
  can_deploy          BOOLEAN NOT NULL DEFAULT FALSE,
  can_approve_merge   BOOLEAN NOT NULL DEFAULT FALSE,
  default_dm_chat_id  BIGINT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_studio_members_bot_label
  ON studio_members(bot_label) WHERE bot_label IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_studio_members_can_deploy
  ON studio_members(can_deploy) WHERE can_deploy = TRUE;

COMMIT;
