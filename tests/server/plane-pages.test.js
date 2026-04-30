import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    PLANE_BASE_URL: 'https://plane.test',
    PLANE_WORKSPACE_SLUG: 'devpanl',
    PLANE_SHELLY_EMAIL: 'shelly@test',
    PLANE_SHELLY_PASSWORD: 'pw'
  };
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

// Mock helper. Sequence determines what each fetch call returns.
// Login flow consumes 2 calls: GET /auth/get-csrf-token/ and POST /auth/sign-in/.
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

function loginResponses() {
  return [
    () => new Response(JSON.stringify({ csrf_token: 'JWT' }), {
      status: 200,
      headers: { 'set-cookie': 'csrftoken=COOKIE; Path=/; HttpOnly' }
    }),
    () => new Response('', {
      status: 302,
      headers: { 'set-cookie': 'session-id=SESSION; Path=/; HttpOnly' }
    })
  ];
}

describe('plane-pages — login', () => {
  it('GETs csrf token and POSTs sign-in form, then caches the session', async () => {
    const calls = mockFetchSequence([
      ...loginResponses(),
      () => new Response(JSON.stringify([{ id: 'p1' }]), { status: 200 })
    ]);
    const { listPages, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    await listPages('proj-uuid');

    expect(calls[0].url).toBe('https://plane.test/auth/get-csrf-token/');
    expect(calls[0].method).toBe('GET');
    expect(calls[1].url).toBe('https://plane.test/auth/sign-in/');
    expect(calls[1].method).toBe('POST');
    expect(calls[1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(calls[1].headers['X-CSRFToken']).toBe('JWT');
    expect(String(calls[1].body)).toContain('email=shelly%40test');
    expect(String(calls[1].body)).toContain('password=pw');

    // Subsequent call uses the session cookie + no fresh login. Reset only
    // the listPages cache so the assertion below observes a real fetch
    // (the cookie session must persist across the reset).
    __internal._resetListPagesCache();
    const calls2 = mockFetchSequence([
      () => new Response(JSON.stringify([]), { status: 200 })
    ]);
    await listPages('proj-uuid');
    expect(calls2[0].url).toBe('https://plane.test/api/workspaces/devpanl/projects/proj-uuid/pages/');
    expect(calls2[0].headers.Cookie).toContain('session-id=SESSION');
    expect(calls2[0].headers.Cookie).toContain('csrftoken=COOKIE');
  });

  it('throws when service-account env vars are missing', async () => {
    delete process.env.PLANE_SHELLY_EMAIL;
    const { listPages, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    await expect(listPages('proj-uuid')).rejects.toThrow(/PLANE_SHELLY_EMAIL/);
  });
});

describe('plane-pages — listPages / getPage / getPageHtml', () => {
  it('lists pages on the right URL', async () => {
    const calls = mockFetchSequence([
      ...loginResponses(),
      () => new Response(JSON.stringify([{ id: 'page1', name: 'Hello' }]), { status: 200 })
    ]);
    const { listPages, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    const rows = await listPages('proj-uuid');
    expect(rows).toEqual([{ id: 'page1', name: 'Hello' }]);
    expect(calls[2].url).toBe('https://plane.test/api/workspaces/devpanl/projects/proj-uuid/pages/');
    expect(calls[2].method).toBe('GET');
  });

  it('reads description_html from the page metadata, not /description/', async () => {
    mockFetchSequence([
      ...loginResponses(),
      () => new Response(JSON.stringify({ id: 'page1', description_html: '<p>hi</p>' }), { status: 200 })
    ]);
    const { getPageHtml, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    const html = await getPageHtml('proj', 'page1');
    expect(html).toBe('<p>hi</p>');
  });

  it('surfaces upstream errors with status + body', async () => {
    mockFetchSequence([
      ...loginResponses(),
      () => new Response('boom', { status: 500 })
    ]);
    const { getPage, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    await expect(getPage('proj', 'pageX')).rejects.toThrow(/HTTP 500.*boom/);
  });
});

describe('plane-pages — createPage', () => {
  it('POSTs the right body and includes X-CSRFToken', async () => {
    const calls = mockFetchSequence([
      ...loginResponses(),
      () => new Response(JSON.stringify({ id: 'page-new' }), { status: 201 })
    ]);
    const { createPage, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    await createPage('proj-uuid', { name: 'Retro 2026-Q2', description_html: '<h1>retro</h1>' });
    expect(calls[2].method).toBe('POST');
    expect(calls[2].headers['Content-Type']).toBe('application/json');
    expect(calls[2].headers['X-CSRFToken']).toBe('JWT');
    const body = JSON.parse(calls[2].body);
    expect(body).toEqual({ name: 'Retro 2026-Q2', description_html: '<h1>retro</h1>', access: 0, parent: null });
  });

  it('rejects when name is missing', async () => {
    mockFetchSequence([...loginResponses()]);
    const { createPage, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    await expect(createPage('proj', { description_html: '<p/>' })).rejects.toThrow(/name is required/);
  });
});

describe('plane-pages — updatePage', () => {
  it('PATCHes only allowed fields', async () => {
    const calls = mockFetchSequence([
      ...loginResponses(),
      () => new Response(JSON.stringify({ id: 'p1', name: 'New' }), { status: 200 })
    ]);
    const { updatePage, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    await updatePage('proj', 'p1', { name: 'New', description_html: '<x/>', random: 'nope' });
    const body = JSON.parse(calls[2].body);
    expect(body).toEqual({ name: 'New' });
    expect(calls[2].method).toBe('PATCH');
  });

  it('throws when no allowed fields supplied', async () => {
    mockFetchSequence([...loginResponses()]);
    const { updatePage, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    await expect(updatePage('proj', 'p1', { description_html: '<x/>' })).rejects.toThrow(/no updatable fields/);
  });
});

describe('plane-pages — updatePageContent', () => {
  it('PATCHes /description/ with description_html', async () => {
    const calls = mockFetchSequence([
      ...loginResponses(),
      () => new Response('', { status: 200 })
    ]);
    const { updatePageContent, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    await updatePageContent('proj', 'p1', '<p>updated</p>');
    expect(calls[2].url.endsWith('/p1/description/')).toBe(true);
    expect(calls[2].method).toBe('PATCH');
    expect(JSON.parse(calls[2].body)).toEqual({ description_html: '<p>updated</p>' });
  });
});

describe('plane-pages — archive / delete', () => {
  it('archivePage POSTs to /archive/', async () => {
    const calls = mockFetchSequence([
      ...loginResponses(),
      () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    ]);
    const { archivePage, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    await archivePage('proj', 'p1');
    expect(calls[2].method).toBe('POST');
    expect(calls[2].url.endsWith('/p1/archive/')).toBe(true);
  });

  it('deletePage(force=true) archives then deletes', async () => {
    const calls = mockFetchSequence([
      ...loginResponses(),
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),  // archive
      () => new Response(null, { status: 204 })                              // delete
    ]);
    const { deletePage, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    await deletePage('proj', 'p1', { force: true });
    expect(calls[2].url.endsWith('/p1/archive/')).toBe(true);
    expect(calls[3].method).toBe('DELETE');
  });

  it('deletePage without force surfaces 400 from Plane', async () => {
    mockFetchSequence([
      ...loginResponses(),
      () => new Response(JSON.stringify({ error: 'archive first' }), { status: 400 })
    ]);
    const { deletePage, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    await expect(deletePage('proj', 'p1')).rejects.toThrow(/HTTP 400/);
  });
});

describe('plane-pages — pagesHealthcheck', () => {
  it('returns ok=true on 200', async () => {
    mockFetchSequence([
      ...loginResponses(),
      () => new Response(JSON.stringify([]), { status: 200 })
    ]);
    const { pagesHealthcheck, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    const out = await pagesHealthcheck('proj');
    expect(out).toEqual({ ok: true, status: 200 });
  });

  it('returns ok=false with status + body on failure, never throws', async () => {
    mockFetchSequence([
      ...loginResponses(),
      () => new Response('nope', { status: 502 })
    ]);
    const { pagesHealthcheck, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    const out = await pagesHealthcheck('proj');
    expect(out.ok).toBe(false);
    expect(out.status).toBe(502);
    expect(out.body).toContain('nope');
  });
});

describe('plane-pages — session refresh on 401', () => {
  it('re-logs in once when a request returns 401', async () => {
    const calls = mockFetchSequence([
      ...loginResponses(),                                                    // initial login
      () => new Response(JSON.stringify({ detail: 'expired' }), { status: 401 }), // first call → 401
      ...loginResponses(),                                                    // re-login
      () => new Response(JSON.stringify([]), { status: 200 })                 // retry
    ]);
    const { listPages, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    await listPages('proj');
    expect(calls.length).toBe(6);
    // The retry should also be the listPages URL.
    expect(calls[5].url).toContain('/pages/');
  });
});
