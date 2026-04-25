import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.PG_HOST,
  port: parseInt(process.env.PG_PORT ?? '5432', 10),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  max: 4
});

export type DevBotRow = {
  id: number;
  bot_token: string;
  bot_username: string;
  bot_label: string;
  owner_tg_user_id: bigint | null;
  owner_first_name: string | null;
};

export async function loadActiveBots(): Promise<DevBotRow[]> {
  const { rows } = await pool.query(
    `SELECT id, bot_token, bot_username, bot_label,
            owner_tg_user_id, owner_first_name
     FROM dev_bots WHERE status='active' ORDER BY id`
  );
  return rows;
}

export async function markRevoked(id: number): Promise<void> {
  await pool.query(`UPDATE dev_bots SET status='revoked' WHERE id=$1`, [id]);
}

export async function updateOwner(id: number, tgUserId: bigint, firstName: string): Promise<void> {
  await pool.query(
    `UPDATE dev_bots SET owner_tg_user_id=$1, owner_first_name=$2 WHERE id=$3`,
    [tgUserId, firstName, id]
  );
}

export async function touchInbound(id: number): Promise<void> {
  await pool.query(`UPDATE dev_bots SET last_inbound_at=now() WHERE id=$1`, [id]);
}
