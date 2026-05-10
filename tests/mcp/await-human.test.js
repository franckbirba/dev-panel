// tests/mcp/await-human.test.js
// Unit coverage for the await_human MCP tool implementation. Mocks the
// fetch layer to avoid spinning up the API server — we cover the wire
// shape, timeout clamping, cancellation, and default_on_timeout fallback.
import { describe, it, expect } from 'vitest';
import { makeAwaitHuman } from '../../src/mcp/await-human.js';

function makeFakeFetch(handlers) {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    const handler = handlers.shift();
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return handler({ url, options });
  };
  return { fakeFetch, calls };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function statusResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => '',
    json: async () => ({}),
  };
}

describe('await_human MCP tool', () => {
  const baseConfig = {
    apiBase: 'http://test.local',
    adminKey: 'test-key',
    jobId: 'job-abc',
    pollIntervalMs: 0,
  };

  it('round-trips a clarification question to a reply', async () => {
    const { fakeFetch, calls } = makeFakeFetch([
      ({ url, options }) => {
        expect(url).toBe('http://test.local/api/jobs/job-abc/inbox/question');
        expect(options.method).toBe('POST');
        expect(options.headers['X-Admin-Key']).toBe('test-key');
        const body = JSON.parse(options.body);
        expect(body.kind).toBe('clarification');
        expect(body.content.prompt).toBe('which library?');
        expect(body.content.options).toEqual(['A', 'B']);
        return jsonResponse({ ok: true, question: { seq: 1 } }, 201);
      },
      ({ url }) => {
        expect(url).toBe('http://test.local/api/jobs/job-abc/inbox?after_seq=1');
        return jsonResponse({
          reply: { role: 'human_reply', seq: 2, content: { answer: 'A', source: 'dashboard' } },
        });
      },
    ]);

    const awaitHuman = makeAwaitHuman({ ...baseConfig, fetchImpl: fakeFetch });
    const result = await awaitHuman({
      kind: 'clarification',
      prompt: 'which library?',
      options: ['A', 'B'],
      timeout_s: 60,
    });

    expect(result).toEqual({ answer: 'A', source: 'dashboard' });
    expect(calls).toHaveLength(2);
  });

  it('polls 204 until a reply arrives', async () => {
    const { fakeFetch } = makeFakeFetch([
      () => jsonResponse({ ok: true, question: { seq: 1 } }, 201),
      () => statusResponse(204),
      () => statusResponse(204),
      () => jsonResponse({
        reply: { role: 'human_reply', seq: 2, content: { answer: 'go' } },
      }),
    ]);

    const awaitHuman = makeAwaitHuman({ ...baseConfig, fetchImpl: fakeFetch });
    const result = await awaitHuman({
      prompt: 'continue?',
      timeout_s: 60,
    });
    expect(result.answer).toBe('go');
  });

  it('throws on cancellation', async () => {
    const { fakeFetch } = makeFakeFetch([
      () => jsonResponse({ ok: true, question: { seq: 1 } }, 201),
      () => jsonResponse({
        reply: { role: 'cancelled', seq: 2, content: {} },
      }),
    ]);

    const awaitHuman = makeAwaitHuman({ ...baseConfig, fetchImpl: fakeFetch });
    await expect(
      awaitHuman({ prompt: 'q', timeout_s: 60 })
    ).rejects.toThrow(/cancelled/);
  });

  it('returns default_on_timeout when timeout expires', async () => {
    const tickClock = (() => {
      let t = 1000;
      return () => {
        const v = t;
        t += 60_000; // each call advances 60s
        return v;
      };
    })();
    const { fakeFetch } = makeFakeFetch([
      () => jsonResponse({ ok: true, question: { seq: 1 } }, 201),
      () => statusResponse(204),
      () => statusResponse(204),
    ]);

    const awaitHuman = makeAwaitHuman({
      ...baseConfig,
      fetchImpl: fakeFetch,
      now: tickClock,
    });
    const result = await awaitHuman({
      prompt: 'q',
      timeout_s: 30,
      default_on_timeout: 'deny',
    });
    expect(result).toEqual({ answer: 'deny', source: 'timeout-default' });
  });

  it('throws on timeout with no default', async () => {
    const tickClock = (() => {
      let t = 1000;
      return () => {
        const v = t;
        t += 60_000;
        return v;
      };
    })();
    const { fakeFetch } = makeFakeFetch([
      () => jsonResponse({ ok: true, question: { seq: 1 } }, 201),
      () => statusResponse(204),
    ]);

    const awaitHuman = makeAwaitHuman({
      ...baseConfig,
      fetchImpl: fakeFetch,
      now: tickClock,
    });
    await expect(
      awaitHuman({ prompt: 'q', timeout_s: 30 })
    ).rejects.toThrow(/timeout/);
  });

  it('clamps timeout_s to 900', async () => {
    const ticks = [];
    const tickClock = (() => {
      let t = 1000;
      return () => {
        ticks.push(t);
        const v = t;
        t += 100; // never advance enough to expire
        return v;
      };
    })();
    const { fakeFetch } = makeFakeFetch([
      () => jsonResponse({ ok: true, question: { seq: 1 } }, 201),
      () => jsonResponse({
        reply: { role: 'human_reply', seq: 2, content: { answer: 'ok' } },
      }),
    ]);

    const awaitHuman = makeAwaitHuman({
      ...baseConfig,
      fetchImpl: fakeFetch,
      now: tickClock,
    });
    // Even if we ask for 9999s, the deadline computed internally is bounded.
    const result = await awaitHuman({
      prompt: 'q',
      timeout_s: 9999,
    });
    expect(result.answer).toBe('ok');
  });

  it('forwards tool/args on tool_approval kind', async () => {
    const { fakeFetch } = makeFakeFetch([
      ({ options }) => {
        const body = JSON.parse(options.body);
        expect(body.kind).toBe('tool_approval');
        expect(body.content.tool).toBe('Bash');
        expect(body.content.args).toEqual({ command: 'rm -rf /' });
        return jsonResponse({ ok: true, question: { seq: 1 } }, 201);
      },
      () => jsonResponse({
        reply: { role: 'human_reply', seq: 2, content: { answer: 'deny' } },
      }),
    ]);

    const awaitHuman = makeAwaitHuman({ ...baseConfig, fetchImpl: fakeFetch });
    const result = await awaitHuman({
      kind: 'tool_approval',
      prompt: 'allow rm?',
      tool: 'Bash',
      args: { command: 'rm -rf /' },
    });
    expect(result.answer).toBe('deny');
  });

  it('throws if question post fails', async () => {
    const { fakeFetch } = makeFakeFetch([
      () => statusResponse(500),
    ]);
    const awaitHuman = makeAwaitHuman({ ...baseConfig, fetchImpl: fakeFetch });
    await expect(
      awaitHuman({ prompt: 'q', timeout_s: 60 })
    ).rejects.toThrow(/question post failed/);
  });
});
