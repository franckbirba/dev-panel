// src/server/pg.js
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.PG_HOST || 'devpanel-postgres',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  user: process.env.PG_USER || 'affine',
  password: process.env.PG_PASSWORD || '',
  database: process.env.PG_DATABASE || 'agent_memory',
  max: 10
});

function vecLiteral(arr) {
  return `[${arr.join(',')}]`;
}

export async function memoryInsert({
  namespace, agent, kind, title, content,
  module_id = null, cycle_id = null, work_item_id = null,
  tags = [], embedding, expires_at = null
}) {
  const { rows } = await pool.query(
    `INSERT INTO memories
       (namespace, agent, kind, module_id, cycle_id, work_item_id,
        title, content, tags, embedding, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector,$11)
     RETURNING id`,
    [namespace, agent, kind, module_id, cycle_id, work_item_id,
     title, content, tags, vecLiteral(embedding), expires_at]
  );
  return rows[0].id;
}

export async function memorySearchSql({
  namespace, embedding, kind = null, agent = null, module_id = null, limit = 5
}) {
  const params = [namespace, vecLiteral(embedding), limit];
  const clauses = ['namespace = $1'];
  if (kind)      { params.push(kind);      clauses.push(`kind = $${params.length}`); }
  if (agent)     { params.push(agent);     clauses.push(`agent = $${params.length}`); }
  if (module_id) { params.push(module_id); clauses.push(`module_id = $${params.length}`); }

  const sql = `
    SELECT id, agent, kind, title, content, module_id, cycle_id, work_item_id,
           tags, created_at,
           1 - (embedding <=> $2::vector) AS score
      FROM memories
     WHERE ${clauses.join(' AND ')}
     ORDER BY embedding <=> $2::vector
     LIMIT $3`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

export async function memoryList({
  namespace, kind = null, agent = null, module_id = null, limit = 20
}) {
  const params = [namespace];
  const clauses = ['namespace = $1'];
  if (kind)      { params.push(kind);      clauses.push(`kind = $${params.length}`); }
  if (agent)     { params.push(agent);     clauses.push(`agent = $${params.length}`); }
  if (module_id) { params.push(module_id); clauses.push(`module_id = $${params.length}`); }
  params.push(limit);

  const sql = `
    SELECT id, agent, kind, title, content, module_id, cycle_id, work_item_id,
           tags, created_at
      FROM memories
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

// ---------------------------------------------------------------------------
// Shelly transcript — verbatim conversation log queries.
//
// Schema: infra/migrations/009-shelly-transcript.sql
// Writes: plugins/telegram-multi/src/loader.ts#recordTranscript
// Reads (Shelly-facing MCP tools): src/mcp/server.js (transcript_search,
// transcript_range, transcript_replay_recent).
//
// All three helpers return rows shaped:
//   { id, ts, bot_label, tg_chat_id, tg_user_id, tg_message_id,
//     direction, role, source, thread_subject, content,
//     attachment_path, attachment_kind, meta }
// ---------------------------------------------------------------------------

const TRANSCRIPT_SELECT = `
  SELECT id, ts, bot_label, bot_username, tg_chat_id, tg_user_id, tg_message_id,
         direction, role, source, thread_subject, content,
         attachment_path, attachment_kind, meta`;

// Full-text search with optional time-range and faceted filters.
// `query` is plain text — we use `plainto_tsquery` so callers don't need to
// know tsquery syntax. Falls back to a `content ILIKE` substring match when
// `tsquery` returns nothing useful (which happens for tokens shorter than 3
// chars, all-symbol queries, or French apostrophes that simple-config splits
// awkwardly). The pg_trgm GIN index makes ILIKE cheap.
export async function transcriptSearch({
  query, since = null, until = null, bot_label = null, thread_subject = null,
  direction = null, limit = 50
}) {
  const params = [];
  const clauses = [];
  // FTS first (fast path).
  params.push(query);
  clauses.push(
    `(to_tsvector('simple', content) @@ plainto_tsquery('simple', $${params.length})
      OR content ILIKE '%' || $${params.length} || '%')`
  );
  if (since)         { params.push(since);         clauses.push(`ts >= $${params.length}`); }
  if (until)         { params.push(until);         clauses.push(`ts <= $${params.length}`); }
  if (bot_label)     { params.push(bot_label);     clauses.push(`bot_label = $${params.length}`); }
  if (thread_subject){ params.push(thread_subject);clauses.push(`thread_subject = $${params.length}`); }
  if (direction)     { params.push(direction);     clauses.push(`direction = $${params.length}`); }
  params.push(limit);
  const sql = `${TRANSCRIPT_SELECT}
      FROM shelly_transcript
     WHERE ${clauses.join(' AND ')}
     ORDER BY ts DESC
     LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

// Pure time-range scan, no query. For "show me everything since X" use cases
// (post-restart context restoration). `since` is required to keep accidental
// full-table scans from sneaking in.
export async function transcriptRange({
  since, until = null, bot_label = null, thread_subject = null,
  direction = null, limit = 200
}) {
  if (!since) throw new Error('transcriptRange requires `since`');
  const params = [since];
  const clauses = [`ts >= $${params.length}`];
  if (until)         { params.push(until);         clauses.push(`ts <= $${params.length}`); }
  if (bot_label)     { params.push(bot_label);     clauses.push(`bot_label = $${params.length}`); }
  if (thread_subject){ params.push(thread_subject);clauses.push(`thread_subject = $${params.length}`); }
  if (direction)     { params.push(direction);     clauses.push(`direction = $${params.length}`); }
  params.push(limit);
  const sql = `${TRANSCRIPT_SELECT}
      FROM shelly_transcript
     WHERE ${clauses.join(' AND ')}
     ORDER BY ts ASC
     LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

