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
