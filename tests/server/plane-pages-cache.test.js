// Tests for the listPages 60s cache that powers the FAQ flow (DEVPA-164).
//
// Acceptance criteria pinned by these tests:
//   1. Repeated listPages() calls within the TTL → only one Plane fetch.
//   2. After the TTL elapses → cache miss, second fetch.
//   3. Different project ids → independent cache entries.
//   4. Page mutations (create/update/archive/delete) invalidate the cache.
//   5. The bypassCache flag forces a fresh fetch.
//   6. A typical FAQ flow (1 list + 1 get + optional retry, repeated for the
//      next user message in the same minute) stays ≤ 3 Plane fetches.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    PLANE_BASE_URL: 'https://plane.test',
    PLANE_WORKSPACE_SLUG: 'devpanl',
    PLANE_SHELLY_EMAIL: 'shelly@test',
    PLANE_SHELLY_PASSWORD: 'pw',
  };
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function loginResponses() {
  return [
    () => new Response(JSON.stringify({ csrf_token: 'JWT' }), {
      status: 200,
      headers: { 'set-cookie': 'csrftoken=COOKIE; Path=/; HttpOnly' },
    }),
    () => new Response('', {
      status: 302,
      headers: { 'set-cookie': 'session-id=SESSION; Path=/; HttpOnly' },
    }),
  ];
}

// Builds a long fetch stub. The login dance consumes 2 calls each time the
// cookie cache is reset, then `pageHandlers` are consumed in order. Returns
// a `calls` array recording every fetch for assertions.
function mockFetchSequence(handlers) {
  let i = 0;
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), method: (init.method || 'GET').toUpperCase() });
    const handler = handlers[i++];
    if (!handler) throw new Error(`unexpected fetch #${i} to ${url}`);
    return handler({ url: String(url), init });
  });
  return calls;
}

function listResp(rows) {
  return () => new Response(JSON.stringify(rows), { status: 200 });
}

function pageResp(page) {
  return () => new Response(JSON.stringify(page), { status: 200 });
}

describe('plane-pages cache — listPages TTL', () => {
  it('serves the second listPages call from cache within TTL (single Plane fetch)', async () => {
    const calls = mockFetchSequence([
      ...loginResponses(),
      listResp([{ id: 'p1', name: 'FAQ' }]),
    ]);
    const { listPages, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    __internal._resetListPagesCache();

    const a = await listPages('proj-uuid');
    const b = await listPages('proj-uuid');
    const c = await listPages('proj-uuid');

    expect(a).toEqual([{ id: 'p1', name: 'FAQ' }]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // 2 login calls + 1 listPages call = 3, no second listing fetch.
    expect(calls.length).toBe(3);
    expect(calls[2].url).toBe('https://plane.test/api/workspaces/devpanl/projects/proj-uuid/pages/');
  });

  it('refetches after the TTL elapses', async () => {
    vi.useFakeTimers({ now: 0 });
    const calls = mockFetchSequence([
      ...loginResponses(),
      listResp([{ id: 'p1', name: 'old' }]),
      listResp([{ id: 'p1', name: 'new' }]),
    ]);
    const { listPages, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    __internal._resetListPagesCache();

    const first = await listPages('proj-uuid');
    expect(first[0].name).toBe('old');

    // Stay inside TTL — cached.
    vi.advanceTimersByTime(30_000);
    const cached = await listPages('proj-uuid');
    expect(cached[0].name).toBe('old');
    expect(calls.length).toBe(3);

    // Advance past TTL (60s default).
    vi.advanceTimersByTime(31_000);
    const refetched = await listPages('proj-uuid');
    expect(refetched[0].name).toBe('new');
    expect(calls.length).toBe(4);
  });

  it('keeps independent cache entries per project', async () => {
    const calls = mockFetchSequence([
      ...loginResponses(),
      listResp([{ id: 'a1', name: 'Apple FAQ' }]),
      listResp([{ id: 'b1', name: 'Banana FAQ' }]),
    ]);
    const { listPages, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    __internal._resetListPagesCache();

    const apple = await listPages('proj-apple');
    const banana = await listPages('proj-banana');

    expect(apple[0].name).toBe('Apple FAQ');
    expect(banana[0].name).toBe('Banana FAQ');
    expect(calls.length).toBe(4); // 2 login + 2 distinct listings.

    // Both subsequent reads come from cache.
    await listPages('proj-apple');
    await listPages('proj-banana');
    expect(calls.length).toBe(4);
  });

  it('bypassCache forces a fresh fetch even within TTL', async () => {
    const calls = mockFetchSequence([
      ...loginResponses(),
      listResp([{ id: 'p1', name: 'first' }]),
      listResp([{ id: 'p1', name: 'second' }]),
    ]);
    const { listPages, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    __internal._resetListPagesCache();

    await listPages('proj-uuid');
    expect(calls.length).toBe(3);

    const fresh = await listPages('proj-uuid', { bypassCache: true });
    expect(fresh[0].name).toBe('second');
    expect(calls.length).toBe(4);

    // The fresh value is now what's cached.
    const cached = await listPages('proj-uuid');
    expect(cached[0].name).toBe('second');
    expect(calls.length).toBe(4);
  });

  it('rejects when projectId is missing', async () => {
    mockFetchSequence([...loginResponses()]);
    const { listPages, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    __internal._resetListPagesCache();
    await expect(listPages('')).rejects.toThrow(/projectId is required/);
    await expect(listPages(null)).rejects.toThrow(/projectId is required/);
  });
});

describe('plane-pages cache — write invalidation', () => {
  it('createPage invalidates the cache for that project', async () => {
    const calls = mockFetchSequence([
      ...loginResponses(),
      listResp([{ id: 'p1', name: 'old' }]),
      pageResp({ id: 'pNEW', name: 'new page' }),
      listResp([{ id: 'p1', name: 'old' }, { id: 'pNEW', name: 'new page' }]),
    ]);
    const { listPages, createPage, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    __internal._resetListPagesCache();

    await listPages('proj-uuid');
    await createPage('proj-uuid', { name: 'new page' });
    const after = await listPages('proj-uuid');

    expect(after).toHaveLength(2);
    // 2 login + 1 list + 1 create + 1 list (no cache hit on the second list).
    expect(calls.length).toBe(5);
  });

  it('updatePage / archivePage invalidate the cache', async () => {
    const calls = mockFetchSequence([
      ...loginResponses(),
      listResp([{ id: 'p1', name: 'old' }]),
      pageResp({ id: 'p1', name: 'renamed' }),
      listResp([{ id: 'p1', name: 'renamed' }]),
      pageResp({ ok: true }),
      listResp([]),
    ]);
    const { listPages, updatePage, archivePage, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    __internal._resetListPagesCache();

    await listPages('proj-uuid');
    await updatePage('proj-uuid', 'p1', { name: 'renamed' });
    const renamed = await listPages('proj-uuid');
    expect(renamed[0].name).toBe('renamed');

    await archivePage('proj-uuid', 'p1');
    const empty = await listPages('proj-uuid');
    expect(empty).toEqual([]);
  });

  it('deletePage(force=true) invalidates the cache', async () => {
    mockFetchSequence([
      ...loginResponses(),
      listResp([{ id: 'p1', name: 'doomed' }]),
      pageResp({ ok: true }),                                // archive (force)
      () => new Response(null, { status: 204 }),             // delete
      listResp([]),
    ]);
    const { listPages, deletePage, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    __internal._resetListPagesCache();

    await listPages('proj-uuid');
    await deletePage('proj-uuid', 'p1', { force: true });
    const after = await listPages('proj-uuid');
    expect(after).toEqual([]);
  });
});

describe('plane-pages cache — FAQ flow budget (≤ 3 Plane calls per user message)', () => {
  it('list + get + retry stays within 3 Plane fetches per user message', async () => {
    const calls = mockFetchSequence([
      ...loginResponses(),
      listResp([
        { id: 'page-pwd', name: 'Réinitialiser votre mot de passe' },
        { id: 'page-onboard', name: 'Onboarding' },
      ]),
      pageResp({ id: 'page-pwd', name: 'Réinitialiser votre mot de passe', description_html: '<p>Cliquez sur ...</p>' }),
      pageResp({ id: 'page-onboard', name: 'Onboarding', description_html: '<p>...</p>' }),
    ]);
    const { listPages, getPage, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    __internal._resetListPagesCache();

    // Simulated user-message #1: question on a Zeno-like project.
    const projectId = 'zeno-uuid';
    const pages = await listPages(projectId);
    const candidate = pages.find(p => /mot de passe/i.test(p.name));
    expect(candidate).toBeTruthy();
    const html = await getPage(projectId, candidate.id);
    expect(html.description_html).toContain('Cliquez');
    // Optional retry on a second candidate (worst-case)
    await getPage(projectId, 'page-onboard');

    // 2 login + 1 list + 2 reads = 5 fetches total. Of those, only the last
    // 3 are "Plane FAQ calls" the SOUL budgets against (login is one-time).
    expect(calls.length).toBe(5);
    const planeFaqCalls = calls.filter(c =>
      c.url.includes('/projects/zeno-uuid/pages/'),
    );
    expect(planeFaqCalls.length).toBeLessThanOrEqual(3);
  });

  it('next user-message in the same minute reuses the cached page list', async () => {
    const calls = mockFetchSequence([
      ...loginResponses(),
      listResp([
        { id: 'page-pwd', name: 'Réinitialiser votre mot de passe' },
        { id: 'page-billing', name: 'Facturation' },
      ]),
      pageResp({ id: 'page-pwd', description_html: '<p>x</p>' }),
      pageResp({ id: 'page-billing', description_html: '<p>y</p>' }),
    ]);
    const { listPages, getPage, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    __internal._resetListPagesCache();

    const projectId = 'zeno-uuid';

    // user msg 1
    const pages1 = await listPages(projectId);
    await getPage(projectId, pages1[0].id);

    // user msg 2 (same minute, different question — billing this time)
    const pages2 = await listPages(projectId); // cache hit
    const billing = pages2.find(p => /facturation/i.test(p.name));
    await getPage(projectId, billing.id);

    // Only ONE listPages fetch hit Plane. Across both user messages we used
    // 1 list + 2 reads = 3 Plane FAQ calls total, well within budget.
    const listingHits = calls.filter(c =>
      c.url.endsWith('/projects/zeno-uuid/pages/') && c.method === 'GET',
    );
    expect(listingHits.length).toBe(1);
  });

  it('no-candidate path → no getPage call, single list call (≤ 1 Plane FAQ call)', async () => {
    const calls = mockFetchSequence([
      ...loginResponses(),
      listResp([{ id: 'page-onboard', name: 'Onboarding' }]),
    ]);
    const { listPages, __internal } = await import('../../src/mcp/plane-pages.js');
    __internal._resetSession();
    __internal._resetListPagesCache();

    const projectId = 'zeno-uuid';
    const pages = await listPages(projectId);
    // Caller-side title match — no candidate found for "comment supprimer
    // mon compte" against an onboarding-only doc set. SOUL says: don't call
    // getPage, fallback to capture offer.
    const candidate = pages.find(p => /supprimer.*compte|delete account/i.test(p.name));
    expect(candidate).toBeUndefined();

    const planeFaqCalls = calls.filter(c =>
      c.url.includes('/projects/zeno-uuid/'),
    );
    expect(planeFaqCalls.length).toBe(1);
  });
});
