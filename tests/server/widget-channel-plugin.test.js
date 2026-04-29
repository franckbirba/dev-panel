// tests/server/widget-channel-plugin.test.js
//
// Unit tests for the widget-channel MCP plugin. Imports the plugin's
// pure functions (buildInboundEnvelope, widgetReply) without booting the
// stdio server or opening Redis.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildInboundEnvelope, widgetReply } from '../../plugins/widget-channel/server.js';

describe('widget-channel: buildInboundEnvelope', () => {
  it('produces a notifications/claude/channel envelope with widget metadata', () => {
    const job = {
      id: '42',
      data: {
        session_id: 'sess-xyz123',
        content: 'comment exporter mes données?',
        project_id: 'proj-1',
        message_id: 'widget-msg-1',
        enqueued_at: '2026-04-28T22:00:00.000Z',
      },
    };
    const env = buildInboundEnvelope(job);
    expect(env.method).toBe('notifications/claude/channel');
    expect(env.params.content).toBe('comment exporter mes données?');
    expect(env.params.meta.source).toBe('widget');
    expect(env.params.meta.session_id).toBe('sess-xyz123');
    expect(env.params.meta.message_id).toBe('42');
    expect(env.params.meta.widget_message_id).toBe('widget-msg-1');
    expect(env.params.meta.project_id).toBe('proj-1');
    expect(env.params.meta.ts).toBe('2026-04-28T22:00:00.000Z');
  });

  it('tolerates missing optional fields', () => {
    const env = buildInboundEnvelope({ id: '7', data: { session_id: 's', content: 'hi' } });
    expect(env.params.meta.source).toBe('widget');
    expect(env.params.meta.session_id).toBe('s');
    expect(env.params.meta.project_id).toBe('');
    expect(env.params.meta.widget_message_id).toBeUndefined();
  });
});

describe('widget-channel: widgetReply', () => {
  let saved;
  beforeEach(() => {
    saved = process.env.WIDGET_INTERNAL_SECRET;
    process.env.WIDGET_INTERNAL_SECRET = 'unit-secret';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.WIDGET_INTERNAL_SECRET;
    else process.env.WIDGET_INTERNAL_SECRET = saved;
  });

  it('rejects missing session_id', async () => {
    await expect(widgetReply({ content: 'hi' })).rejects.toThrow(/session_id/);
  });

  it('rejects missing content', async () => {
    await expect(widgetReply({ session_id: 's' })).rejects.toThrow(/content/);
  });

  it('rejects when secret not configured', async () => {
    delete process.env.WIDGET_INTERNAL_SECRET;
    await expect(widgetReply({ session_id: 's', content: 'hi' })).rejects.toThrow(/SECRET/);
  });

  it('POSTs to the internal endpoint with the shared secret header and parsed body', async () => {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, delivered: 1, buffered: false, dropped: 0 });
        },
      };
    };
    const out = await widgetReply(
      { session_id: 'sess-abcdef', content: 'salut', refs: [{ label: 'Plane', url: 'https://x' }] },
      { fetchImpl: fakeFetch },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/api\/internal\/widget\/sessions\/sess-abcdef\/reply$/);
    expect(calls[0].init.headers['X-Internal-Secret']).toBe('unit-secret');
    const body = JSON.parse(calls[0].init.body);
    expect(body.content).toBe('salut');
    expect(body.refs).toEqual([{ label: 'Plane', url: 'https://x' }]);
    expect(out.delivered).toBe(1);
  });

  it('throws on non-2xx HTTP responses', async () => {
    const fakeFetch = async () => ({
      ok: false, status: 401,
      async text() { return JSON.stringify({ error: 'invalid internal secret' }); },
    });
    await expect(
      widgetReply({ session_id: 'sess-abcdef', content: 'hi' }, { fetchImpl: fakeFetch }),
    ).rejects.toThrow(/HTTP 401/);
  });
});
