// tests/server/telegram-hitl.test.js
// Coverage for the outbound Telegram HITL bridge: when await_human posts
// a question, we send Telegram a message with the right shape (inline
// keyboard for multiple choice, ForceReply for free-form, allow/deny for
// tool_approval). Records tg_message_id in telegram_pending_replies for
// ForceReply lookups.
//
// Mocks the Telegram API via fetch so tests run hermetically.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('telegram-hitl bridge', () => {
  let bridge, pool;
  let fetchCalls;
  let originalFetch;

  beforeAll(async () => {
    await startPg();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '5663177530';
    bridge = await import('../../src/server/telegram-hitl.js');
    ({ pool } = await import('../../src/server/pg.js'));
  }, 60000);

  afterAll(async () => {
    await stopPg();
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  beforeEach(async () => {
    await truncateOrchestration();
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      fetchCalls.push({ url, opts });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 9001, chat: { id: 5663177530 } } }),
        text: async () => JSON.stringify({ ok: true, result: { message_id: 9001 } }),
      };
    });
  });

  it('sends an inline keyboard for clarification with options', async () => {
    await bridge.sendInboxQuestion({
      job_id: 'j1',
      inbox_seq: 1,
      kind: 'clarification',
      content: { prompt: 'which?', options: ['A', 'B', 'C'] },
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://api.telegram.org/bottest-token/sendMessage');
    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.chat_id).toBe('5663177530');
    expect(body.text).toContain('which?');
    expect(body.reply_markup.inline_keyboard).toHaveLength(3);
    expect(body.reply_markup.inline_keyboard[0][0]).toEqual({
      text: 'A',
      callback_data: 'inbox:j1:1:0',
    });
    expect(body.reply_markup.inline_keyboard[2][0].callback_data).toBe('inbox:j1:1:2');
  });

  it('sends ForceReply for clarification without options + records pending row', async () => {
    await bridge.sendInboxQuestion({
      job_id: 'j2',
      inbox_seq: 1,
      kind: 'clarification',
      content: { prompt: 'why?' },
    });

    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.reply_markup.force_reply).toBe(true);
    expect(body.reply_markup.selective).toBe(true);
    expect(body.text).toContain('why?');

    const r = await pool.query(
      `SELECT tg_chat_id, tg_message_id, job_id, inbox_seq FROM telegram_pending_replies`
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].tg_message_id).toBe('9001');
    expect(r.rows[0].job_id).toBe('j2');
    expect(r.rows[0].inbox_seq).toBe(1);
  });

  it('sends Allow/Deny inline keyboard for tool_approval', async () => {
    await bridge.sendInboxQuestion({
      job_id: 'j3',
      inbox_seq: 1,
      kind: 'tool_approval',
      content: {
        prompt: 'allow rm -rf /?',
        tool: 'Bash',
        args: { command: 'rm -rf /' },
      },
    });

    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.reply_markup.inline_keyboard).toHaveLength(2);
    const labels = body.reply_markup.inline_keyboard.map(row => row[0].text);
    expect(labels[0]).toMatch(/Allow/);
    expect(labels[1]).toMatch(/Deny/);
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe('inbox:j3:1:allow');
    expect(body.reply_markup.inline_keyboard[1][0].callback_data).toBe('inbox:j3:1:deny');
    expect(body.text).toContain('Bash');
    expect(body.text).toContain('rm -rf /');
  });

  it('parseInboxCallback decodes inline keyboard callback_data', () => {
    expect(bridge.parseInboxCallback('inbox:j1:1:0')).toEqual({
      job_id: 'j1', inbox_seq: 1, idx: 0, kind: 'option',
    });
    expect(bridge.parseInboxCallback('inbox:job-abc:42:allow')).toEqual({
      job_id: 'job-abc', inbox_seq: 42, idx: null, kind: 'allow',
    });
    expect(bridge.parseInboxCallback('inbox:job:7:deny')).toEqual({
      job_id: 'job', inbox_seq: 7, idx: null, kind: 'deny',
    });
    expect(bridge.parseInboxCallback('not-inbox')).toBeNull();
    expect(bridge.parseInboxCallback('inbox:incomplete')).toBeNull();
  });

  it('resolveOption returns the answer string for a given option idx', () => {
    expect(bridge.resolveOption({ options: ['A', 'B', 'C'] }, 1)).toBe('B');
    expect(bridge.resolveOption({ options: ['A', 'B'] }, 99)).toBeNull();
    expect(bridge.resolveOption({}, 0)).toBeNull();
  });

  it('resolveForceReply finds job by tg_message_id', async () => {
    await bridge.recordPendingReply({
      tg_chat_id: 5663177530n,
      tg_message_id: 9999n,
      job_id: 'job-a',
      inbox_seq: 1,
    });
    const found = await bridge.resolveForceReply({
      tg_chat_id: 5663177530n,
      tg_message_id: 9999n,
    });
    expect(found).toEqual({ job_id: 'job-a', inbox_seq: 1 });
    const missing = await bridge.resolveForceReply({
      tg_chat_id: 5663177530n,
      tg_message_id: 1n,
    });
    expect(missing).toBeNull();
  });

  it('clearPendingReply removes the row', async () => {
    await bridge.recordPendingReply({
      tg_chat_id: 5663177530n,
      tg_message_id: 9999n,
      job_id: 'job-a',
      inbox_seq: 1,
    });
    await bridge.clearPendingReply({
      tg_chat_id: 5663177530n,
      tg_message_id: 9999n,
    });
    const found = await bridge.resolveForceReply({
      tg_chat_id: 5663177530n,
      tg_message_id: 9999n,
    });
    expect(found).toBeNull();
  });

  it('confirmReply edits the message text via Telegram', async () => {
    await bridge.confirmReply({
      tg_chat_id: 5663177530n,
      tg_message_id: 100n,
      original_prompt: 'which?',
      answer: 'A',
      source: 'dashboard',
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://api.telegram.org/bottest-token/editMessageText');
    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.chat_id).toBe('5663177530');
    expect(String(body.message_id)).toBe('100');
    expect(body.text).toContain('which?');
    expect(body.text).toContain('A');
    expect(body.text).toContain('dashboard');
  });

  it('answerCallbackQuery hits the correct endpoint', async () => {
    await bridge.answerCallback({ callback_query_id: 'cb-1', text: 'envoyé' });
    expect(fetchCalls[0].url).toBe('https://api.telegram.org/bottest-token/answerCallbackQuery');
    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.callback_query_id).toBe('cb-1');
    expect(body.text).toBe('envoyé');
  });

  it('skips Telegram send when TELEGRAM_BOT_TOKEN is missing', async () => {
    const original = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    const result = await bridge.sendInboxQuestion({
      job_id: 'j-no-token',
      inbox_seq: 1,
      kind: 'clarification',
      content: { prompt: 'q' },
    });
    expect(result).toEqual({ skipped: true, reason: 'no_token' });
    expect(fetchCalls).toHaveLength(0);
    process.env.TELEGRAM_BOT_TOKEN = original;
  });
});
