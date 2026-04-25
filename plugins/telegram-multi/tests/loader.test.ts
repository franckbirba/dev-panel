import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import pg from 'pg';
import { loadActiveBots, markRevoked, touchInbound, updateOwner } from '../src/loader.ts';

const HAS_PG = Boolean(process.env.PG_HOST);
const pool = new pg.Pool({
  host: process.env.PG_HOST, port: +(process.env.PG_PORT ?? 5432),
  user: process.env.PG_USER, password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE
});

describe.skipIf(!HAS_PG)('loader', () => {
  beforeAll(async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS dev_bots (
      id SERIAL PRIMARY KEY, bot_token TEXT UNIQUE NOT NULL,
      bot_username TEXT NOT NULL, bot_label TEXT UNIQUE NOT NULL,
      owner_tg_user_id BIGINT, owner_first_name TEXT,
      paired_by_tg_user_id BIGINT NOT NULL,
      paired_at TIMESTAMPTZ DEFAULT now(), status TEXT DEFAULT 'active',
      last_inbound_at TIMESTAMPTZ)`);
  });
  beforeEach(async () => { await pool.query('TRUNCATE dev_bots RESTART IDENTITY'); });
  afterAll(async () => { await pool.query('DROP TABLE IF EXISTS dev_bots'); await pool.end(); });

  it('loads active bots', async () => {
    await pool.query(`INSERT INTO dev_bots (bot_token, bot_username, bot_label, paired_by_tg_user_id)
                      VALUES ('T1', 'a_bot', 'a', 1), ('T2', 'b_bot', 'b', 1)`);
    await pool.query(`UPDATE dev_bots SET status='revoked' WHERE bot_label='b'`);
    const bots = await loadActiveBots();
    expect(bots).toHaveLength(1);
    expect(bots[0].bot_label).toBe('a');
  });

  it('marks a bot revoked', async () => {
    const r = await pool.query(`INSERT INTO dev_bots (bot_token, bot_username, bot_label, paired_by_tg_user_id)
                                VALUES ('T1', 'a_bot', 'a', 1) RETURNING id`);
    await markRevoked(r.rows[0].id);
    const bots = await loadActiveBots();
    expect(bots).toHaveLength(0);
  });

  it('updates owner', async () => {
    const r = await pool.query(`INSERT INTO dev_bots (bot_token, bot_username, bot_label, paired_by_tg_user_id)
                                VALUES ('T1', 'a_bot', 'a', 1) RETURNING id`);
    await updateOwner(r.rows[0].id, 999n, 'Alice');
    const { rows } = await pool.query(`SELECT * FROM dev_bots WHERE id=$1`, [r.rows[0].id]);
    expect(rows[0].owner_first_name).toBe('Alice');
  });

  it('touches last_inbound_at', async () => {
    const r = await pool.query(`INSERT INTO dev_bots (bot_token, bot_username, bot_label, paired_by_tg_user_id)
                                VALUES ('T1', 'a_bot', 'a', 1) RETURNING id`);
    await touchInbound(r.rows[0].id);
    const { rows } = await pool.query(`SELECT last_inbound_at FROM dev_bots WHERE id=$1`, [r.rows[0].id]);
    expect(rows[0].last_inbound_at).not.toBeNull();
  });
});
