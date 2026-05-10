// tests/server/notify-event.test.js
// notifyEvent fires sendMessage per destination resolved from notify-routing.
// Mocks fetch globally to capture Telegram API calls.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateStudioMembers } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('notifyEvent', () => {
  let alerts, studio;
  let calls;
  let originalFetch;

  beforeAll(async () => {
    await startPg();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    delete process.env.SHELLY_TELEGRAM_WEBHOOK; // disable the webhook path
    alerts = await import('../../src/server/alerts.js');
    studio = await import('../../src/server/studio-members.js');
  }, 60000);

  afterAll(async () => {
    await stopPg();
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  beforeEach(async () => {
    await truncateStudioMembers();
    await studio.upsertMember({
      tg_user_id: 1n, display_name: 'Franck', bot_label: 'franck',
      projects: ['DEVPA', 'ZENO'], roles: [],
      can_deploy: true, can_approve_merge: true, default_dm_chat_id: 1001n,
    });
    await studio.upsertMember({
      tg_user_id: 2n, display_name: 'Edwin', bot_label: 'edwin',
      projects: ['ZENO'], roles: [],
      can_deploy: false, can_approve_merge: false, default_dm_chat_id: 1002n,
    });
    calls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      calls.push({ url, body: JSON.parse(opts.body || '{}') });
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true }),
        text: async () => '{}',
      };
    });
  });

  it('fans out morning_digest to all studio members', async () => {
    await alerts.notifyEvent({ kind: 'morning_digest', text: 'Pulse:\n- shipped 3' });
    expect(calls).toHaveLength(2);
    const recipients = calls.map(c => c.body.chat_id).sort();
    expect(recipients).toEqual(['1001', '1002']);
    expect(calls[0].body.text).toContain('Pulse');
  });

  it('fans out deploy only to can_deploy members', async () => {
    await alerts.notifyEvent({ kind: 'deploy', text: 'main → prod' });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.chat_id).toBe('1001');
  });

  it('fans out pr_shipped to project_members of payload.project', async () => {
    await alerts.notifyEvent({
      kind: 'pr_shipped',
      text: 'PR #42 shipped',
      payload: { project: 'ZENO' },
    });
    expect(calls.map(c => c.body.chat_id).sort()).toEqual(['1001', '1002']);
  });

  it('await_human routes to a single requester', async () => {
    await alerts.notifyEvent({
      kind: 'await_human',
      text: 'Agent stuck on lib choice',
      payload: { requester_tg_user_id: 2 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.chat_id).toBe('1002');
  });

  it('returns { sent: 0 } when no recipients resolve', async () => {
    const result = await alerts.notifyEvent({
      kind: 'pr_shipped',
      text: 'orphan',
      payload: { project: 'GHOST' },
    });
    expect(calls).toHaveLength(0);
    expect(result.sent).toBe(0);
  });

  it('returns { sent: 0, skipped: "no_token" } when TELEGRAM_BOT_TOKEN missing', async () => {
    const orig = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      const result = await alerts.notifyEvent({
        kind: 'morning_digest',
        text: 'pulse',
      });
      expect(calls).toHaveLength(0);
      expect(result.sent).toBe(0);
      expect(result.skipped).toBe('no_token');
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = orig;
    }
  });

  it('returns { sent } on success', async () => {
    const result = await alerts.notifyEvent({
      kind: 'morning_digest',
      text: 'pulse',
    });
    expect(result.sent).toBe(2);
  });

  it('survives partial Telegram failures', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      calls.push({ url, body: JSON.parse(opts.body || '{}') });
      n += 1;
      if (n === 1) throw new Error('network down');
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' };
    });
    const result = await alerts.notifyEvent({
      kind: 'morning_digest',
      text: 'pulse',
    });
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
  });
});
