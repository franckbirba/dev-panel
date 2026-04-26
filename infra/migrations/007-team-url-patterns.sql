-- 007-team-url-patterns.sql
-- URL-pattern classifier for capture autoroute. When the widget user doesn't
-- pick a category, the API extracts the page URL from the capture metadata
-- and tries patterns in order; the first match wins. Stays a deterministic
-- server-side classifier so notifications work whether or not Shelly is
-- awake.
--
-- pattern: substring match against the URL path, case-insensitive. Examples:
--   "/admissions"  matches "https://zeno.epitools.bj/app/admissions/123"
--   "/cours"       matches "https://zeno.epitools.bj/app/cours"

BEGIN;

CREATE TABLE IF NOT EXISTS team_url_patterns (
  id              SERIAL PRIMARY KEY,
  project_id      TEXT NOT NULL,
  pattern         TEXT NOT NULL,
  label           TEXT NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 100,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (project_id, pattern)
);

CREATE INDEX IF NOT EXISTS team_url_patterns_project_idx
  ON team_url_patterns(project_id, priority);

COMMIT;
