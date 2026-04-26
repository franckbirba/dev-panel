import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notifyTicketNew, formatTicketNewLine } from '../../src/server/alerts.js';

describe('formatTicketNewLine', () => {
  it('formats a single line with empty category', () => {
    expect(
      formatTicketNewLine({ project: 'Zeno', ticket_id: 42, category: null,
        title: 'Login button broken on mobile' })
    ).toBe('[ticket-new] project=Zeno ticket=42 category= title="Login button broken on mobile"');
  });
  it('truncates title to 100 chars and strips newlines', () => {
    const long = 'x'.repeat(150).replace(/x/g, 'A');
    const noNL = 'A\nB\nC';
    const out = formatTicketNewLine({ project: 'p', ticket_id: 1, category: 'com', title: long });
    expect(out).toMatch(/^\[ticket-new\] project=p ticket=1 category=com title="A{100}"$/);
    const out2 = formatTicketNewLine({ project: 'p', ticket_id: 1, category: '', title: noNL });
    expect(out2).toBe('[ticket-new] project=p ticket=1 category= title="A B C"');
  });
});

describe('notifyTicketNew', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    process.env.TELEGRAM_CHAT_ID = '123';
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  });
  it('calls Telegram with the formatted line', async () => {
    await notifyTicketNew({ project: 'Zeno', ticket_id: 42, category: '', title: 'X' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, init] = global.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.text).toContain('[ticket-new] project=Zeno');
  });
  it('no-ops when no destination configured', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await notifyTicketNew({ project: 'p', ticket_id: 1, category: '', title: 't' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
