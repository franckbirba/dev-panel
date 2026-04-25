import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { pool } from '../../src/server/pg.js';
import { mountDevBotsRoutes } from '../../src/server/routes-dev-bots.js';
import { listActiveDevBots, findDevBotByToken } from '../../src/server/dev-bots.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('multi-dev pairing — end-to-end', () => {
  let app, request;

  beforeAll(async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS dev_bots (
      id SERIAL PRIMARY KEY, bot_token TEXT UNIQUE NOT NULL,
      bot_username TEXT NOT NULL, bot_label TEXT UNIQUE NOT NULL,
      owner_tg_user_id BIGINT, owner_first_name TEXT,
      paired_by_tg_user_id BIGINT NOT NULL,
      paired_at TIMESTAMPTZ DEFAULT now(), status TEXT DEFAULT 'active',
      last_inbound_at TIMESTAMPTZ)`);
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (typeof url === 'string' && url.includes('/getMe')) {
        return { ok: true, json: async () => ({ ok: true, result: { username: 'alice_bot' } }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
    app = express();
    app.use(express.json());
    mountDevBotsRoutes(app);
    request = supertest(app);
  });

  beforeEach(async () => { await pool.query('TRUNCATE dev_bots RESTART IDENTITY'); });
  afterAll(async () => { await pool.query('DROP TABLE IF EXISTS dev_bots'); });

  it('pair → loader sees row → first inbound captures owner → revoke removes row', async () => {
    // 1. Franck pairs Alice's bot via the API (simulating Shelly's POST).
    const pair = await request.post('/api/dev-bots').send({
      token: 'ALICE:tok', label: 'alice', paired_by_tg_user_id: '5663177530'
    });
    expect(pair.status).toBe(201);
    expect(pair.body.bot_username).toBe('alice_bot');

    // 2. The plugin's loader (simulated as a direct DAO call) now sees the row.
    const active = await listActiveDevBots();
    expect(active).toHaveLength(1);
    expect(active[0].bot_label).toBe('alice');
    expect(active[0].owner_tg_user_id).toBeNull();

    // 3. Alice DMs her bot — the plugin captures owner via PATCH.
    const owned = await request.patch(`/api/dev-bots/${pair.body.id}/owner`).send({
      owner_tg_user_id: '999', owner_first_name: 'Alice'
    });
    expect(owned.status).toBe(200);
    const row = await findDevBotByToken('ALICE:tok');
    expect(String(row.owner_tg_user_id)).toBe('999');
    expect(row.owner_first_name).toBe('Alice');

    // 4. Franck revokes the bot.
    const del = await request.delete(`/api/dev-bots/${pair.body.id}`);
    expect(del.status).toBe(204);
    expect(await listActiveDevBots()).toHaveLength(0);
  });
});
