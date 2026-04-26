-- 006-team-routing.sql
-- Per-project team roster + label routing for ticket notifications.
--
-- team_members: people who can receive ticket DMs on a project. Linked to a
-- paired Telegram bot row in dev_bots; tg_user_id is denormalized so Shelly's
-- MCP doesn't have to JOIN to find the chat target.
--
-- team_routing: project-scoped {label -> member} map. The DevPanel widget
-- exposes the labels as a category dropdown; Shelly classifies into them when
-- the user doesn't pick one.

BEGIN;

CREATE TABLE IF NOT EXISTS team_members (
  id              SERIAL PRIMARY KEY,
  project_id      TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  dev_bot_id      INTEGER REFERENCES dev_bots(id),
  tg_user_id      BIGINT,
  added_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE (project_id, display_name),
  UNIQUE (project_id, dev_bot_id)
);

CREATE INDEX IF NOT EXISTS team_members_project_idx ON team_members(project_id);

CREATE TABLE IF NOT EXISTS team_routing (
  id              SERIAL PRIMARY KEY,
  project_id      TEXT NOT NULL,
  label           TEXT NOT NULL,
  member_id       INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (project_id, label)
);

CREATE INDEX IF NOT EXISTS team_routing_project_idx ON team_routing(project_id);

COMMIT;
