// tests/server/alerts.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('notifyJob', () => {
  beforeEach(() => {
    process.env.SHELLY_TELEGRAM_WEBHOOK = 'https://webhook.test/hook';
    process.env.SHELLY_DEBOUNCE_MS = '0';
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.resetModules();
  });

  it('formats a DONE line without emoji', async () => {
    const { notifyJob } = await import('../../src/server/alerts.js');
    await notifyJob({
      agent: 'builder',
      work_item_id: 'wi_a1b2',
      title: 'fix login flow',
      status: 'done',
      duration_ms: 12000,
      extra: '3 commits',
      next_agent: 'reviewer'
    });
    // Wait for debounce (0ms, but setTimeout is async)
    await new Promise(r => setTimeout(r, 20));
    expect(global.fetch).toHaveBeenCalled();
    const call = global.fetch.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.text).toContain('[builder]');
    expect(body.text).toContain('DONE');
    expect(body.text).toContain('next: reviewer');
    expect(body.text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('is a no-op when webhook is not configured', async () => {
    delete process.env.SHELLY_TELEGRAM_WEBHOOK;
    const { notifyJob } = await import('../../src/server/alerts.js');
    await notifyJob({ agent: 'x', work_item_id: 'w', title: 't', status: 'done' });
    await new Promise(r => setTimeout(r, 20));
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
