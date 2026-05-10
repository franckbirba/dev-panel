// tests/server/studio-members-loader.test.js
// The plugin's loadStudioMembers() runs in bun and reads Postgres
// directly. We can't import the .ts file from vitest cleanly without a
// transpile step, so we replicate the SQL contract here against a real
// Postgres and assert the shape. If the loader's SQL drifts, this test
// is the canary.
//
// Tests the same SELECT the plugin issues + the graceful fallback when
// the table doesn't exist (older agents host without migration 012).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateStudioMembers, getPool } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('plugin loadStudioMembers contract', () => {
  let sm;
  let pool;

  beforeAll(async () => {
    await startPg();
    sm = await import('../../src/server/studio-members.js');
    pool = getPool();
  }, 60000);

  afterAll(async () => {
    await stopPg();
  });

  beforeEach(() => truncateStudioMembers());

  it('SELECT tg_user_id FROM studio_members returns BIGINT-as-string Set', async () => {
    await sm.upsertMember({
      tg_user_id: 5663177530n, display_name: 'Franck', bot_label: 'franck',
      projects: [], roles: [], can_deploy: true, can_approve_merge: true,
      default_dm_chat_id: 5663177530n,
    });
    await sm.upsertMember({
      tg_user_id: 100n, display_name: 'Edwin', bot_label: 'edwin',
      projects: [], roles: [], can_deploy: false, can_approve_merge: false,
      default_dm_chat_id: 100n,
    });
    // Replicate the plugin's exact query shape.
    const { rows } = await pool.query(`SELECT tg_user_id FROM studio_members`);
    const studio = new Set(rows.map(r => String(r.tg_user_id)));
    expect(studio.size).toBe(2);
    expect(studio.has('5663177530')).toBe(true);
    expect(studio.has('100')).toBe(true);
  });

  it('returns empty Set when no members exist', async () => {
    const { rows } = await pool.query(`SELECT tg_user_id FROM studio_members`);
    expect(rows).toHaveLength(0);
  });

  it('graceful fallback: query against missing table errors with relation-not-exist', async () => {
    // Verify the error message shape the plugin's regex matches.
    await pool.query(`DROP TABLE studio_members`);
    let err;
    try {
      await pool.query(`SELECT tg_user_id FROM studio_members`);
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(/relation .* does not exist/i.test(err.message)).toBe(true);
    // Restore for any test that runs after.
    await pool.query(`
      CREATE TABLE studio_members (
        tg_user_id BIGINT PRIMARY KEY,
        display_name TEXT NOT NULL,
        bot_label TEXT,
        projects TEXT[] NOT NULL DEFAULT '{}',
        roles TEXT[] NOT NULL DEFAULT '{}',
        can_deploy BOOLEAN NOT NULL DEFAULT FALSE,
        can_approve_merge BOOLEAN NOT NULL DEFAULT FALSE,
        default_dm_chat_id BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  });
});
