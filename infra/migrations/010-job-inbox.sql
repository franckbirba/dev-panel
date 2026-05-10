-- 010-job-inbox.sql
-- HITL primitive (Spec: docs/superpowers/specs/2026-05-09-agent-interactivity-v2-design.md)
-- Adds the per-job message channel that powers `await_human` MCP tool.
--
-- The agent calls `await_human(prompt, options?, kind)`, which writes an
-- agent_question row, flips workflow_instances.status to 'awaiting_input',
-- and long-polls until a matching human_reply row arrives. Human replies
-- come from the dashboard reply composer or Telegram (inline keyboard /
-- ForceReply). Both write to POST /api/jobs/:id/inbox.
--
-- Idempotency: callback_query retries from Telegram (when answerCallbackQuery
-- is slow >3s) are deduped via seen_callback_ids. Lost-update protection on
-- the agent_question row uses the consumed_at IS NULL predicate.

BEGIN;

CREATE TABLE IF NOT EXISTS job_inbox (
  id                BIGSERIAL PRIMARY KEY,
  job_id            TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('agent_question', 'human_reply', 'cancelled')),
  kind              TEXT NOT NULL CHECK (kind IN ('clarification', 'tool_approval')),
  content           JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at       TIMESTAMPTZ,
  seen_callback_ids TEXT[] NOT NULL DEFAULT '{}',
  UNIQUE (job_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_job_inbox_pending
  ON job_inbox(job_id, consumed_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_job_inbox_job_seq
  ON job_inbox(job_id, seq);

-- workflow_instances.status was unconstrained TEXT; we add 'awaiting_input'
-- to the active-set partial unique index so a paused workflow still blocks
-- duplicate dispatches.
DROP INDEX IF EXISTS idx_wi_workflow_active;
CREATE UNIQUE INDEX idx_wi_workflow_active
  ON workflow_instances(work_item_id, workflow_name)
  WHERE status IN ('running', 'awaiting_approval', 'awaiting_input');

COMMIT;
