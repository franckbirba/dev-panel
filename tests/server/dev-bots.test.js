import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { pool } from '../../src/server/pg.js';
import {
  insertDevBot, listActiveDevBots, listAllDevBots,
  findDevBotByToken, findDevBotById, revokeDevBot,
  updateDevBotOwner, touchInbound
} from '../../src/server/dev-bots.js';
import { mountDevBotsRoutes } from '../../src/server/routes-dev-bots.js';

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

d('POST/GET/DELETE /api/dev-bots', () => {
  let app, request;
  beforeAll(async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS dev_bots (
      id SERIAL PRIMARY KEY, bot_token TEXT UNIQUE NOT NULL,
      bot_username TEXT NOT NULL, bot_label TEXT UNIQUE NOT NULL,
      owner_tg_user_id BIGINT, owner_first_name TEXT,
      paired_by_tg_user_id BIGINT NOT NULL,
      paired_at TIMESTAMPTZ DEFAULT now(), status TEXT DEFAULT 'active',
      last_inbound_at TIMESTAMPTZ)`);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE dev_bots RESTART IDENTITY');
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (typeof url === 'string' && url.includes('/getMe')) {
        if (url.includes('/botGOOD')) {
          return { ok: true, json: async () => ({ ok: true, result: { username: 'good_bot' } }) };
        }
        return { ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
    app = express();
    app.use(express.json());
    mountDevBotsRoutes(app);
    request = supertest(app);
  });

  it('creates a paired bot when getMe succeeds', async () => {
    const r = await request.post('/api/dev-bots').send({
      token: 'GOOD:abc', label: 'alice', paired_by_tg_user_id: '5663177530'
    });
    expect(r.status).toBe(201);
    expect(r.body.bot_username).toBe('good_bot');
    expect(r.body.bot_label).toBe('alice');
  });

  it('rejects an invalid token', async () => {
    const r = await request.post('/api/dev-bots').send({
      token: 'BAD:xyz', label: 'alice', paired_by_tg_user_id: '5663177530'
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Unauthorized/);
  });

  it('returns 409 on duplicate token', async () => {
    await request.post('/api/dev-bots').send({
      token: 'GOOD:abc', label: 'alice', paired_by_tg_user_id: '1'
    });
    const r = await request.post('/api/dev-bots').send({
      token: 'GOOD:abc', label: 'alice2', paired_by_tg_user_id: '1'
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already paired/i);
  });

  it('GET /api/dev-bots lists active rows', async () => {
    await request.post('/api/dev-bots').send({
      token: 'GOOD:abc', label: 'alice', paired_by_tg_user_id: '1'
    });
    const r = await request.get('/api/dev-bots');
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
  });

  it('DELETE /api/dev-bots/:id revokes', async () => {
    const c = await request.post('/api/dev-bots').send({
      token: 'GOOD:abc', label: 'alice', paired_by_tg_user_id: '1'
    });
    const r = await request.delete(`/api/dev-bots/${c.body.id}`);
    expect(r.status).toBe(204);
    const list = await request.get('/api/dev-bots?status=active');
    expect(list.body).toHaveLength(0);
  });

  it('PATCH /api/dev-bots/:id/owner sets owner', async () => {
    const c = await request.post('/api/dev-bots').send({
      token: 'GOOD:abc', label: 'alice', paired_by_tg_user_id: '1'
    });
    const r = await request.patch(`/api/dev-bots/${c.body.id}/owner`).send({
      owner_tg_user_id: '999', owner_first_name: 'Alice'
    });
    expect(r.status).toBe(200);
    expect(r.body.owner_first_name).toBe('Alice');
  });
});
