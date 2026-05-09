import pg from 'pg';

// Lazy: server.ts loads ~/.claude/channels/telegram/.env into process.env
// AFTER imports run. Constructing the Pool at import time would freeze the
// PG_* values before they're populated and we'd silently fall back to
// pg's $USER/$PGPASSWORD defaults — which on the agents host is `deploy`,
// not the `affine` role that owns dev_bots.
let _pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (_pool) return _pool;
  _pool = new pg.Pool({
    host: process.env.PG_HOST,
    port: parseInt(process.env.PG_PORT ?? '5432', 10),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    max: 4
  });
  return _pool;
}

export type DevBotRow = {
  id: number;
  bot_token: string;
  bot_username: string;
  bot_label: string;
  owner_tg_user_id: bigint | null;
  owner_first_name: string | null;
};

export async function loadActiveBots(): Promise<DevBotRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, bot_token, bot_username, bot_label,
            owner_tg_user_id, owner_first_name
     FROM dev_bots WHERE status='active' ORDER BY id`
  );
  return rows;
}

export async function markRevoked(id: number): Promise<void> {
  await getPool().query(`UPDATE dev_bots SET status='revoked' WHERE id=$1`, [id]);
}

export async function updateOwner(id: number, tgUserId: bigint, firstName: string): Promise<void> {
  await getPool().query(
    `UPDATE dev_bots SET owner_tg_user_id=$1, owner_first_name=$2 WHERE id=$3`,
    [tgUserId, firstName, id]
  );
}

export async function touchInbound(id: number): Promise<void> {
  await getPool().query(`UPDATE dev_bots SET last_inbound_at=now() WHERE id=$1`, [id]);
}

export async function loadAllowlist(): Promise<Set<string>> {
  const { rows } = await getPool().query(
    `SELECT tg_user_id FROM dev_bot_allowlist`
  );
  // Postgres returns BIGINT as string — that's what we want, since the
  // plugin compares against ctx.from.id stringified.
  return new Set(rows.map(r => String(r.tg_user_id)));
}

export async function addToAllowlist(tgUserId: bigint, firstName: string | null, addedVia: string): Promise<void> {
  await getPool().query(
    `INSERT INTO dev_bot_allowlist (tg_user_id, first_name, added_via)
     VALUES ($1, $2, $3)
     ON CONFLICT (tg_user_id) DO UPDATE
       SET first_name = COALESCE(EXCLUDED.first_name, dev_bot_allowlist.first_name)`,
    [tgUserId, firstName, addedVia]
  );
}

// ---------------------------------------------------------------------------
// Verbatim transcript log — every inbound/outbound message lands here so
// Shelly can reconstruct conversation history beyond Claude Code's context
// window. Read via the devpanel-mcp transcript_* tools. Schema in
// infra/migrations/009-shelly-transcript.sql.
// ---------------------------------------------------------------------------

export type TranscriptDirection = 'in' | 'out';
export type TranscriptRole = 'user' | 'shelly' | 'system';

export interface TranscriptRow {
  bot_label: string;
  bot_username?: string | null;
  tg_chat_id?: string | null;
  tg_user_id?: string | null;
  tg_message_id?: number | null;
  direction: TranscriptDirection;
  role: TranscriptRole;
  source?: string;            // default 'telegram'
  thread_subject?: string | null;
  content: string;
  attachment_path?: string | null;
  attachment_kind?: string | null;
  meta?: Record<string, unknown> | null;
}

// Extracts a [thread:<type>/<id>] tag from message content if present.
// Returns just the canonical "<type>/<id>" form, e.g. "capture/47", or null.
// Mirrors the protocol used by `src/server/threads.js` on the dev-panel side.
const THREAD_TAG_RE = /\[thread:([a-z_-]+)\/([^\]\s]+)\]/i;
export function extractThreadSubject(content: string): string | null {
  const m = THREAD_TAG_RE.exec(content || '');
  if (!m) return null;
  return `${m[1].toLowerCase()}/${m[2]}`;
}

// Fire-and-forget. Never throws — transcript writes must NOT block the
// message path. A DB hiccup here loses one log line, not a user message.
export function recordTranscript(row: TranscriptRow): void {
  const subject = row.thread_subject ?? extractThreadSubject(row.content);
  getPool().query(
    `INSERT INTO shelly_transcript
      (bot_label, bot_username, tg_chat_id, tg_user_id, tg_message_id,
       direction, role, source, thread_subject, content,
       attachment_path, attachment_kind, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      row.bot_label,
      row.bot_username ?? null,
      row.tg_chat_id ?? null,
      row.tg_user_id ?? null,
      row.tg_message_id ?? null,
      row.direction,
      row.role,
      row.source ?? 'telegram',
      subject,
      row.content,
      row.attachment_path ?? null,
      row.attachment_kind ?? null,
      row.meta ? JSON.stringify(row.meta) : null,
    ]
  ).catch(err => {
    // Stderr only — the plugin's main `log()` writes to stdout which Claude
    // Code reads as MCP traffic. Don't pollute that channel with DB chatter.
    console.error(`telegram-multi: shelly_transcript insert failed: ${err?.message ?? err}`);
  });
}
