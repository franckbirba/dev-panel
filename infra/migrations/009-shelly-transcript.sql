-- 009-shelly-transcript.sql
--
-- Verbatim, time-indexed log of every message in/out of any Shelly-paired
-- bot. Lives next to dev_bots / memories on services-side Postgres so the
-- telegram-multi plugin (which already has a pg pool there) can write it
-- without a second DB connection.
--
-- Why this exists:
--   Shelly's tmux Claude Code session has a finite context window. Long
--   conversations get auto-compacted — system prompt + earlier turns get
--   summarized into a lossy bullet list. After ~12-19h of activity she
--   forgets context Franck still expects her to know. Persistent
--   pgvector `memories` is summary-shaped, not verbatim — fine for
--   "what did we decide about X" but useless for "what did Franck send
--   me at 14:32 yesterday?".
--
--   This table is the verbatim log. Every inbound DM and every outbound
--   reply lands here, regardless of whether the message was tagged
--   `[thread:foo/bar]` (those still also flow into the existing
--   `thread_messages` table over in SQLite — that's the per-subject
--   conversation surface, this is the global verbatim surface).
--
-- Reads happen via three MCP tools (devpanel-mcp):
--   - transcript_search(q, since?, until?, bot?, subject?, limit?)
--   - transcript_range(since, until?, bot?, limit?)
--   - transcript_replay_recent(minutes=240)

CREATE TABLE IF NOT EXISTS shelly_transcript (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Which paired bot this message went through (franck, alice, …). dev_bots.bot_label.
  bot_label       TEXT NOT NULL,
  bot_username    TEXT,
  -- Telegram identifiers — nullable for outbound where we don't always have them.
  tg_chat_id      TEXT,
  tg_user_id      TEXT,
  tg_message_id   BIGINT,
  -- 'in' = user → Shelly, 'out' = Shelly → user.
  direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
  -- 'user' for human-typed inbounds, 'shelly' for Shelly's outbounds, 'system' for harness-injected.
  role            TEXT NOT NULL,
  -- 'telegram' (default) for now; future: 'dashboard', 'autonomous', 'cron'.
  source          TEXT NOT NULL DEFAULT 'telegram',
  -- If the message had a [thread:<type>/<id>] tag, store as 'capture/47', 'work_item/UUID', etc.
  thread_subject  TEXT,
  -- Verbatim text. No truncation. No re-encoding. Whatever the user/Shelly typed, stored as-is.
  content         TEXT NOT NULL,
  -- For inbound photo/voice/document, the path the plugin saved to ~/.claude/channels/telegram/inbox/.
  attachment_path TEXT,
  attachment_kind TEXT,
  -- Free-form bag for everything else: model/usage on outbound, owner/first_name on inbound, etc.
  meta            JSONB
);

-- Recent-first scan; the most common access pattern.
CREATE INDEX IF NOT EXISTS shelly_transcript_ts ON shelly_transcript (ts DESC);

-- Per-bot range scan: "what's been happening on franck's bot today?"
CREATE INDEX IF NOT EXISTS shelly_transcript_bot_ts ON shelly_transcript (bot_label, ts DESC);

-- Per-thread range scan when the message was tagged: "show me everything on capture/47".
CREATE INDEX IF NOT EXISTS shelly_transcript_subject_ts
  ON shelly_transcript (thread_subject, ts DESC)
  WHERE thread_subject IS NOT NULL;

-- Full-text search on content. tsvector with simple config (no language stemming
-- — content is mixed FR/EN/code, simple is the right choice). GIN over the
-- ts_vector so `to_tsquery` / `plainto_tsquery` queries are sub-second on 10k+
-- rows. We don't store the tsvector as a generated column to keep writes cheap;
-- the GIN index expression handles it. Trade-off: queries must use the same
-- expression — `to_tsvector('simple', content)` — which the MCP tool wraps.
CREATE INDEX IF NOT EXISTS shelly_transcript_content_fts
  ON shelly_transcript
  USING GIN (to_tsvector('simple', content));

-- For sub-string search ("find the message that mentioned 'pi-mcp-adapter'")
-- in case ts_vector tokenization isn't friendly enough — pg_trgm gives us
-- fast LIKE/ILIKE. Optional; keep behind a feature flag if extension isn't
-- already in this DB.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS shelly_transcript_content_trgm
  ON shelly_transcript
  USING GIN (content gin_trgm_ops);
