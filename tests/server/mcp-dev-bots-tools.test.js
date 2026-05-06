// Tests for the dev-bots MCP tool handlers (DEVPA-178).
//
// The handlers in src/mcp/dev-bots-tools.js mirror the HTTP routes in
// src/server/routes-dev-bots.js — Shelly's hard rules forbid fetch, so the
// /pair flow has to live as MCP tools. These tests pin both the happy paths
// and the two error shapes the SOUL relies on (invalid token → 400-equivalent,
// duplicate → 409-equivalent).
//
// Real Postgres only — gated on TEST_PG=1, like tests/server/dev-bots.test.js.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { pool } from '../../src/server/pg.js';
import {
  pairDevBot,
  listDevBots,
  revokeDevBotById,
  listDevBotAllowlist,
  serializeDevBot
} from '../../src/mcp/dev-bots-tools.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('MCP dev-bots tools', () => {
  beforeAll(async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS dev_bots (
      id SERIAL PRIMARY KEY, bot_token TEXT UNIQUE NOT NULL,
      bot_username TEXT NOT NULL, bot_label TEXT UNIQUE NOT NULL,
      owner_tg_user_id BIGINT, owner_first_name TEXT,
      paired_by_tg_user_id BIGINT NOT NULL,
      paired_at TIMESTAMPTZ DEFAULT now(), status TEXT DEFAULT 'active',
      last_inbound_at TIMESTAMPTZ)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dev_bot_allowlist (
      tg_user_id BIGINT PRIMARY KEY,
      first_name TEXT,
      added_at TIMESTAMPTZ DEFAULT now(),
      added_via TEXT DEFAULT 'manual')`);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE dev_bots RESTART IDENTITY');
    await pool.query('TRUNCATE dev_bot_allowlist');
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (typeof url === 'string' && url.includes('/getMe')) {
        if (url.includes('/botGOOD')) {
          return { ok: true, json: async () => ({ ok: true, result: { username: 'good_bot' } }) };
        }
        return { ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS dev_bots');
    await pool.query('DROP TABLE IF EXISTS dev_bot_allowlist');
  });

  describe('pairDevBot', () => {
    it('inserts a dev_bot, allowlists the pairer, and stringifies BigInt fields', async () => {
      const row = await pairDevBot({
        token: 'GOOD:abc',
        label: 'alice',
        paired_by_tg_user_id: '5663177530'
      });
      expect(row.bot_username).toBe('good_bot');
      expect(row.bot_label).toBe('alice');
      expect(row.status).toBe('active');
      // BigInt columns must be JSON-serializable — they would otherwise crash
      // the MCP transport. Assert the type after JSON.stringify round-trip.
      expect(typeof row.paired_by_tg_user_id).toBe('string');
      expect(row.paired_by_tg_user_id).toBe('5663177530');
      expect(JSON.parse(JSON.stringify(row))).toEqual(row);

      const allow = await listDevBotAllowlist();
      expect(allow).toHaveLength(1);
      expect(allow[0].tg_user_id).toBe('5663177530');
      expect(allow[0].added_via).toBe('pair');
    });

    it('throws code=invalid_token when Telegram getMe fails (no DB write)', async () => {
      await expect(pairDevBot({
        token: 'BAD:xyz',
        label: 'alice',
        paired_by_tg_user_id: '1'
      })).rejects.toMatchObject({ code: 'invalid_token', message: expect.stringMatching(/Unauthorized/) });
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM dev_bots');
      expect(rows[0].n).toBe(0);
    });

    it('throws code=duplicate when the token already exists (no second DB write)', async () => {
      await pairDevBot({ token: 'GOOD:abc', label: 'alice', paired_by_tg_user_id: '1' });
      await expect(pairDevBot({
        token: 'GOOD:abc',
        label: 'alice2',
        paired_by_tg_user_id: '1'
      })).rejects.toMatchObject({ code: 'duplicate', message: /already paired/i });
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM dev_bots');
      expect(rows[0].n).toBe(1);
    });

    it('throws code=invalid_args when a required field is missing', async () => {
      await expect(pairDevBot({ token: '', label: 'a', paired_by_tg_user_id: '1' }))
        .rejects.toMatchObject({ code: 'invalid_args' });
      await expect(pairDevBot({ token: 't', label: '', paired_by_tg_user_id: '1' }))
        .rejects.toMatchObject({ code: 'invalid_args' });
      await expect(pairDevBot({ token: 't', label: 'a' }))
        .rejects.toMatchObject({ code: 'invalid_args' });
    });
  });

  describe('listDevBots', () => {
    it('lists active rows when status="active"', async () => {
      await pairDevBot({ token: 'GOOD:abc', label: 'alice', paired_by_tg_user_id: '1' });
      const rows = await listDevBots({ status: 'active' });
      expect(rows).toHaveLength(1);
      expect(rows[0].bot_label).toBe('alice');
      expect(typeof rows[0].paired_by_tg_user_id).toBe('string');
    });

    it('lists all rows including revoked when status is omitted', async () => {
      const row = await pairDevBot({ token: 'GOOD:abc', label: 'alice', paired_by_tg_user_id: '1' });
      await revokeDevBotById({ id: row.id });
      expect(await listDevBots({ status: 'active' })).toHaveLength(0);
      const all = await listDevBots();
      expect(all).toHaveLength(1);
      expect(all[0].status).toBe('revoked');
    });
  });

  describe('revokeDevBotById', () => {
    it('marks a row revoked and accepts numeric or string id', async () => {
      const row = await pairDevBot({ token: 'GOOD:abc', label: 'alice', paired_by_tg_user_id: '1' });
      const r1 = await revokeDevBotById({ id: String(row.id) });
      expect(r1).toEqual({ ok: true, id: row.id });
      const { rows } = await pool.query('SELECT status FROM dev_bots WHERE id=$1', [row.id]);
      expect(rows[0].status).toBe('revoked');
    });

    it('rejects a non-numeric id', async () => {
      await expect(revokeDevBotById({ id: 'not-a-number' }))
        .rejects.toMatchObject({ code: 'invalid_args' });
    });
  });

  describe('listDevBotAllowlist', () => {
    it('returns an empty list when nothing is allowlisted', async () => {
      expect(await listDevBotAllowlist()).toEqual([]);
    });

    it('stringifies tg_user_id BigInts so the response is JSON-serializable', async () => {
      await pairDevBot({ token: 'GOOD:abc', label: 'alice', paired_by_tg_user_id: '5663177530' });
      const list = await listDevBotAllowlist();
      expect(list).toHaveLength(1);
      expect(typeof list[0].tg_user_id).toBe('string');
      expect(list[0].tg_user_id).toBe('5663177530');
      // No BigInt should leak through.
      expect(() => JSON.stringify(list)).not.toThrow();
    });
  });

  describe('serializeDevBot', () => {
    it('returns null for null input', () => {
      expect(serializeDevBot(null)).toBeNull();
    });

    it('keeps owner_tg_user_id null when DB has no owner', async () => {
      const row = await pairDevBot({ token: 'GOOD:abc', label: 'alice', paired_by_tg_user_id: '1' });
      expect(row.owner_tg_user_id).toBeNull();
    });
  });
});
