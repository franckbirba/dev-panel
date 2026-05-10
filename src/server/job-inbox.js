// src/server/job-inbox.js
// HITL inbox primitive — per-job message channel for `await_human` MCP tool.
// Spec: docs/superpowers/specs/2026-05-09-agent-interactivity-v2-design.md
//
// The agent writes a question via postQuestion(), the human (via dashboard
// or Telegram) replies via postReply(), the agent reads it back via
// readNextReply() in a long-poll loop. cancelPending() handles the
// orphan-when-paused case during workflow cancellation.
//
// Idempotency: duplicate Telegram callback_query retries (when
// answerCallbackQuery is slow >3s) carry the same callback_query.id; we
// dedup by appending the id to seen_callback_ids on the question row and
// skipping the second write.
//
// Lost-update protection: postReply consumes the question row in the same
// transaction it writes the reply, predicated on consumed_at IS NULL.

import { pool } from './pg.js';

let _broadcast = null;
async function broadcast(event, data) {
  try {
    if (_broadcast === null) {
      const m = await import('./sse.js');
      _broadcast = m.broadcast || (() => {});
    }
    _broadcast(event, data);
  } catch { /* sse not available */ }
}

async function nextSeq(client, job_id) {
  const r = await client.query(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM job_inbox WHERE job_id = $1`,
    [job_id]
  );
  return r.rows[0].next;
}

export async function postQuestion({ job_id, kind, content }) {
  if (!job_id) throw new Error('job_id required');
  if (!['clarification', 'tool_approval'].includes(kind)) {
    throw new Error(`invalid kind: ${kind}`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const seq = await nextSeq(client, job_id);
    const { rows } = await client.query(
      `INSERT INTO job_inbox (job_id, seq, role, kind, content)
       VALUES ($1, $2, 'agent_question', $3, $4::jsonb)
       RETURNING id, job_id, seq, role, kind, content, created_at, consumed_at, seen_callback_ids`,
      [job_id, seq, kind, JSON.stringify(content)]
    );
    await client.query('COMMIT');
    broadcast('inbox:question', { job_id, seq, kind, content });
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function postReply({ job_id, answer, callback_query_id = null, source = 'human' }) {
  if (!job_id) throw new Error('job_id required');
  if (typeof answer !== 'string') throw new Error('answer must be a string');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotency check: if this callback_query_id has already been seen on
    // ANY question row for this job, treat as duplicate.
    if (callback_query_id) {
      const dup = await client.query(
        `SELECT 1 FROM job_inbox
          WHERE job_id = $1 AND $2 = ANY(seen_callback_ids)
          LIMIT 1`,
        [job_id, callback_query_id]
      );
      if (dup.rows.length > 0) {
        await client.query('COMMIT');
        return { duplicate: true };
      }
    }

    // Consume the latest unconsumed agent_question row in this job. The
    // consumed_at IS NULL predicate gives us lost-update protection: if
    // a concurrent postReply landed first, this UPDATE matches zero rows.
    const consumed = await client.query(
      `UPDATE job_inbox
          SET consumed_at = now(),
              seen_callback_ids = CASE WHEN $2::text IS NULL THEN seen_callback_ids
                                       ELSE array_append(seen_callback_ids, $2)
                                  END
        WHERE id = (
          SELECT id FROM job_inbox
           WHERE job_id = $1
             AND role = 'agent_question'
             AND consumed_at IS NULL
           ORDER BY seq DESC
           LIMIT 1
           FOR UPDATE
        )
        RETURNING seq`,
      [job_id, callback_query_id]
    );
    if (consumed.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error(`no pending question for job ${job_id}`);
    }
    const consumedSeq = consumed.rows[0].seq;

    const replySeq = await nextSeq(client, job_id);
    await client.query(
      `INSERT INTO job_inbox (job_id, seq, role, kind, content)
       VALUES ($1, $2, 'human_reply', 'clarification', $3::jsonb)`,
      [job_id, replySeq, JSON.stringify({ answer, source })]
    );

    await client.query('COMMIT');
    broadcast('inbox:reply', { job_id, seq: replySeq, source });
    return {
      consumed_question_seq: consumedSeq,
      reply_seq: replySeq,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// readNextReply — used by `await_human` MCP tool to long-poll for the answer.
// Returns the first unconsumed-from-the-agent's-perspective row (any row with
// seq > after_seq for this job), or null if nothing new.
export async function readNextReply({ job_id, after_seq = 0 }) {
  const { rows } = await pool.query(
    `SELECT id, job_id, seq, role, kind, content, created_at, consumed_at
       FROM job_inbox
      WHERE job_id = $1 AND seq > $2 AND role IN ('human_reply', 'cancelled')
      ORDER BY seq ASC
      LIMIT 1`,
    [job_id, after_seq]
  );
  if (rows.length === 0) return null;
  return rows[0];
}

export async function cancelPending({ job_id }) {
  const { rows } = await pool.query(
    `UPDATE job_inbox
        SET role = 'cancelled',
            consumed_at = now()
      WHERE job_id = $1
        AND role = 'agent_question'
        AND consumed_at IS NULL
      RETURNING id, seq`,
    [job_id]
  );
  if (rows.length > 0) {
    broadcast('inbox:cancelled', { job_id, count: rows.length });
  }
  return { cancelled_count: rows.length, cancelled_seqs: rows.map(r => r.seq) };
}

export async function listForJob(job_id) {
  const { rows } = await pool.query(
    `SELECT id, job_id, seq, role, kind, content, created_at, consumed_at, seen_callback_ids
       FROM job_inbox
      WHERE job_id = $1
      ORDER BY seq ASC`,
    [job_id]
  );
  return rows;
}
