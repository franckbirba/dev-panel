import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notifyCaptureNew, formatCaptureNewLine } from '../../src/server/alerts.js';

describe('formatCaptureNewLine', () => {
  it('formats a single line with empty category', () => {
    expect(
      formatCaptureNewLine({ project: 'Zeno', capture_id: 'abc-123', category: null,
        content: 'Login button broken on mobile' })
    ).toBe('[capture-new] project=Zeno capture=abc-123 category= content="Login button broken on mobile"');
  });
  it('truncates content to 100 chars and strips newlines', () => {
    const long = 'A'.repeat(150);
    const noNL = 'A\nB\nC';
    const out = formatCaptureNewLine({ project: 'p', capture_id: 'x', category: 'com', content: long });
    expect(out).toMatch(/^\[capture-new\] project=p capture=x category=com content="A{100}"$/);
    const out2 = formatCaptureNewLine({ project: 'p', capture_id: 'x', category: '', content: noNL });
    expect(out2).toBe('[capture-new] project=p capture=x category= content="A B C"');
  });
});

describe('notifyCaptureNew', () => {
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
    await notifyCaptureNew({ project: 'Zeno', capture_id: 'abc-123', category: '', content: 'X' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, init] = global.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.text).toContain('[capture-new] project=Zeno');
  });
  it('no-ops when no destination configured', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await notifyCaptureNew({ project: 'p', capture_id: 'x', category: '', content: 't' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
