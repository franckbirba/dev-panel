import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { pool } from '../../src/server/pg.js';
import { seedFromEnvIfEmpty, listAllDevBots } from '../../src/server/dev-bots.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('dev-bots backward-compat seed', () => {
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
  afterAll(async () => { await pool.query('DROP TABLE IF EXISTS dev_bots'); });

  it('seeds franck row when table empty and env set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ ok: true, result: { username: 'franck_bot' } })
    })));
    const result = await seedFromEnvIfEmpty({
      TELEGRAM_BOT_TOKEN: 'FRANCK:abc',
      TELEGRAM_CHAT_ID: '5663177530'
    });
    expect(result.seeded).toBe(true);
    const rows = await listAllDevBots();
    expect(rows).toHaveLength(1);
    expect(rows[0].bot_label).toBe('franck');
    expect(String(rows[0].owner_tg_user_id)).toBe('5663177530');
  });

  it('is a no-op when env is missing', async () => {
    const r = await seedFromEnvIfEmpty({});
    expect(r.seeded).toBe(false);
    expect(await listAllDevBots()).toHaveLength(0);
  });

  it('is a no-op when table already has rows', async () => {
    await pool.query(
      `INSERT INTO dev_bots (bot_token, bot_username, bot_label, paired_by_tg_user_id)
       VALUES ('X', 'x_bot', 'x', 1)`
    );
    const r = await seedFromEnvIfEmpty({
      TELEGRAM_BOT_TOKEN: 'FRANCK:abc',
      TELEGRAM_CHAT_ID: '5663177530'
    });
    expect(r.seeded).toBe(false);
    expect(await listAllDevBots()).toHaveLength(1);
  });
});
