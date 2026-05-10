-- 011-telegram-pending-replies.sql
-- Maps a Telegram message_id (sent by the bot when posing an `await_human`
-- question) back to the job_inbox row it represents. Needed only for the
-- ForceReply path: when Franck types a free-form reply, Telegram delivers
-- ctx.message.reply_to_message.message_id, and we resolve job_id+seq from
-- this table to know where to POST.
--
-- Inline-keyboard callbacks don't need this table — `callback_data` carries
-- `inbox:<job_id>:<seq>:<option_idx>` directly (≤30 of 64 bytes).
--
-- Rows are inserted when the question is sent, deleted when the reply is
-- consumed. A daily TTL sweep clears anything older than 24h to keep the
-- table small (a paused job that never gets answered shouldn't bloat us).

BEGIN;

CREATE TABLE IF NOT EXISTS telegram_pending_replies (
  tg_chat_id    BIGINT NOT NULL,
  tg_message_id BIGINT NOT NULL,
  job_id        TEXT NOT NULL,
  inbox_seq     INTEGER NOT NULL,
  bot_label     TEXT NOT NULL DEFAULT 'franck',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tg_chat_id, tg_message_id)
);

CREATE INDEX IF NOT EXISTS idx_tg_pending_job
  ON telegram_pending_replies(job_id, inbox_seq);

CREATE INDEX IF NOT EXISTS idx_tg_pending_created
  ON telegram_pending_replies(created_at);

COMMIT;
