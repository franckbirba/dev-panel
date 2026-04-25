import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pool } from '../../src/server/pg.js';
import {
  insertDevBot, listActiveDevBots, listAllDevBots,
  findDevBotByToken, findDevBotById, revokeDevBot,
  updateDevBotOwner, touchInbound
} from '../../src/server/dev-bots.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('dev-bots DAO', () => {
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

  it('inserts and lists a new bot', async () => {
    const id = await insertDevBot({
      bot_token: 'T1', bot_username: 'alice_bot', bot_label: 'alice',
      paired_by_tg_user_id: 5663177530n
    });
    expect(id).toBeGreaterThan(0);
    const active = await listActiveDevBots();
    expect(active).toHaveLength(1);
    expect(active[0].bot_label).toBe('alice');
    expect(active[0].owner_tg_user_id).toBeNull();
  });

  it('rejects duplicate token', async () => {
    await insertDevBot({ bot_token: 'T1', bot_username: 'a_bot', bot_label: 'a', paired_by_tg_user_id: 1n });
    await expect(insertDevBot({
      bot_token: 'T1', bot_username: 'b_bot', bot_label: 'b', paired_by_tg_user_id: 1n
    })).rejects.toThrow(/duplicate|unique/i);
  });

  it('finds by token', async () => {
    await insertDevBot({ bot_token: 'T1', bot_username: 'a_bot', bot_label: 'a', paired_by_tg_user_id: 1n });
    const row = await findDevBotByToken('T1');
    expect(row.bot_label).toBe('a');
    expect(await findDevBotByToken('missing')).toBeNull();
  });

  it('revokes a bot', async () => {
    const id = await insertDevBot({ bot_token: 'T1', bot_username: 'a_bot', bot_label: 'a', paired_by_tg_user_id: 1n });
    await revokeDevBot(id);
    expect(await listActiveDevBots()).toHaveLength(0);
    expect(await listAllDevBots()).toHaveLength(1);
  });

  it('updates owner on first inbound', async () => {
    const id = await insertDevBot({ bot_token: 'T1', bot_username: 'a_bot', bot_label: 'a', paired_by_tg_user_id: 1n });
    await updateDevBotOwner(id, { owner_tg_user_id: 999n, owner_first_name: 'Alice' });
    const row = await findDevBotById(id);
    expect(String(row.owner_tg_user_id)).toBe('999');
    expect(row.owner_first_name).toBe('Alice');
  });

  it('touches last_inbound_at', async () => {
    const id = await insertDevBot({ bot_token: 'T1', bot_username: 'a_bot', bot_label: 'a', paired_by_tg_user_id: 1n });
    await touchInbound(id);
    const row = await findDevBotById(id);
    expect(row.last_inbound_at).toBeInstanceOf(Date);
  });
});
