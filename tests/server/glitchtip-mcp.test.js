import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    GLITCHTIP_BASE_URL: 'https://glitchtip.test',
    GLITCHTIP_API_TOKEN: 'tok_abc'
  };
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

function mockFetchSequence(handlers) {
  let i = 0;
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), method: (init.method || 'GET').toUpperCase(), headers: init.headers || {}, body: init.body });
    const handler = handlers[i++];
    if (!handler) throw new Error(`unexpected fetch #${i} to ${url}`);
    return handler({ url: String(url), init });
  });
  return calls;
}

describe('glitchtip — config', () => {
  it('throws when GLITCHTIP_API_TOKEN is missing', async () => {
    delete process.env.GLITCHTIP_API_TOKEN;
    const { getIssue } = await import('../../src/mcp/glitchtip.js');
    await expect(getIssue('devpanl-studio', '42')).rejects.toThrow(/GLITCHTIP_API_TOKEN/);
  });

  it('uses GLITCHTIP_BASE_URL and Bearer auth', async () => {
    const calls = mockFetchSequence([
      () => new Response(JSON.stringify({ id: '42', title: 't', culprit: 'c', level: 'error', status: 'unresolved' }), { status: 200 }),
      () => new Response(JSON.stringify({ entries: [], message: null }), { status: 200 })
    ]);
    const { getIssue } = await import('../../src/mcp/glitchtip.js');
    await getIssue('devpanl-studio', '42');
    expect(calls[0].url).toBe('https://glitchtip.test/api/0/organizations/devpanl-studio/issues/42/');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers.Authorization).toBe('Bearer tok_abc');
    expect(calls[1].url).toBe('https://glitchtip.test/api/0/organizations/devpanl-studio/issues/42/events/latest/');
  });
});

describe('glitchtip — getIssue', () => {
  it('returns the documented shape: { title, culprit, level, status, last_event }', async () => {
    mockFetchSequence([
      () => new Response(JSON.stringify({
        id: '42',
        title: 'TypeError: x is undefined',
        culprit: 'src/widget.js in render',
        level: 'error',
        status: 'unresolved'
      }), { status: 200 }),
      () => new Response(JSON.stringify({
        message: 'TypeError: x is undefined',
        tags: [{ key: 'browser', value: 'Firefox' }],
        entries: [
          {
            type: 'exception',
            data: {
              values: [
                {
                  type: 'TypeError',
                  value: 'x is undefined',
                  module: null,
                  stacktrace: {
                    frames: [
                      { filename: 'lib.js', function: 'a', lineno: 1, colno: 2, in_app: false },
                      { filename: 'widget.js', function: 'render', lineno: 42, colno: 7, in_app: true }
                    ]
                  }
                }
              ]
            }
          },
          {
            type: 'breadcrumbs',
            data: {
              values: [
                { category: 'navigation', message: '/foo' },
                { category: 'click', message: 'submit' }
              ]
            }
          }
        ]
      }), { status: 200 })
    ]);
    const { getIssue } = await import('../../src/mcp/glitchtip.js');
    const out = await getIssue('devpanl-studio', '42');
    expect(out.title).toBe('TypeError: x is undefined');
    expect(out.culprit).toBe('src/widget.js in render');
    expect(out.level).toBe('error');
    expect(out.status).toBe('unresolved');
    expect(out.last_event.message).toBe('TypeError: x is undefined');
    expect(out.last_event.exception).toEqual([
      { type: 'TypeError', value: 'x is undefined', module: null }
    ]);
    // Frames reversed so the throwing frame comes first.
    expect(out.last_event.stack[0]).toEqual({
      filename: 'widget.js', function: 'render', lineno: 42, colno: 7, in_app: true
    });
    expect(out.last_event.tags).toEqual([{ key: 'browser', value: 'Firefox' }]);
    expect(out.last_event.breadcrumbs).toHaveLength(2);
  });

  it('returns last_event=null when the latest event 404s but the issue exists', async () => {
    mockFetchSequence([
      () => new Response(JSON.stringify({ id: '42', title: 't', culprit: 'c', level: 'error', status: 'unresolved' }), { status: 200 }),
      () => new Response('not found', { status: 404 })
    ]);
    const { getIssue } = await import('../../src/mcp/glitchtip.js');
    const out = await getIssue('devpanl-studio', '42');
    expect(out.title).toBe('t');
    expect(out.last_event).toBeNull();
  });

  it('surfaces 401 from the issue endpoint with a message that names the token', async () => {
    mockFetchSequence([
      () => new Response('unauthorized', { status: 401 })
    ]);
    const { getIssue } = await import('../../src/mcp/glitchtip.js');
    await expect(getIssue('devpanl-studio', '42')).rejects.toThrow(/HTTP 401.*GLITCHTIP_API_TOKEN/);
  });

  it('surfaces 404 from the issue endpoint distinctly', async () => {
    mockFetchSequence([
      () => new Response('not found', { status: 404 })
    ]);
    const { getIssue } = await import('../../src/mcp/glitchtip.js');
    await expect(getIssue('devpanl-studio', '999')).rejects.toThrow(/HTTP 404.*not found/);
  });

  it('rejects when org_slug or issue_id is missing', async () => {
    const { getIssue } = await import('../../src/mcp/glitchtip.js');
    await expect(getIssue('', '42')).rejects.toThrow(/org_slug is required/);
    await expect(getIssue('devpanl-studio', '')).rejects.toThrow(/issue_id is required/);
  });
});

describe('glitchtip — resolveIssue', () => {
  it('PUTs status=resolved with Bearer token and returns the new status', async () => {
    const calls = mockFetchSequence([
      () => new Response(JSON.stringify({ id: '42', status: 'resolved' }), { status: 200 })
    ]);
    const { resolveIssue } = await import('../../src/mcp/glitchtip.js');
    const out = await resolveIssue('devpanl-studio', '42');
    expect(calls[0].url).toBe('https://glitchtip.test/api/0/organizations/devpanl-studio/issues/42/');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].headers.Authorization).toBe('Bearer tok_abc');
    expect(JSON.parse(calls[0].body)).toEqual({ status: 'resolved' });
    expect(out).toEqual({ issue_id: '42', status: 'resolved' });
  });

  it('surfaces 403 explicitly (token without project:write scope)', async () => {
    mockFetchSequence([
      () => new Response('forbidden', { status: 403 })
    ]);
    const { resolveIssue } = await import('../../src/mcp/glitchtip.js');
    await expect(resolveIssue('devpanl-studio', '42')).rejects.toThrow(/HTTP 403.*GLITCHTIP_API_TOKEN/);
  });
});
