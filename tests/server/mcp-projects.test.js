import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    API_BASE: 'https://api.test',
    ADMIN_API_KEY: 'admin-tok'
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

describe('resolveProjectByName — local SQLite path', () => {
  let tmp;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-mcp-proj-'));
    const { initMasterDatabase, createProject } = await import('../../src/server/db.js');
    initMasterDatabase(tmp);
    createProject({
      name: 'Zeno',
      github_owner: 'EpitechAfrik',
      github_repo: 'Zeno'
    });
  });

  it('resolves by name via local SQLite without hitting the API', async () => {
    const calls = mockFetchSequence([]);
    const { resolveProjectByName } = await import('../../src/mcp/projects.js');
    const proj = await resolveProjectByName('Zeno');
    expect(proj?.name).toBe('Zeno');
    expect(proj?.api_key).toMatch(/^dp_/);
    expect(calls).toHaveLength(0);
  });

  it('resolves by UUID via local SQLite without hitting the API', async () => {
    const { listProjects } = await import('../../src/server/db.js');
    const seeded = listProjects()[0];
    const calls = mockFetchSequence([]);
    const { resolveProjectByName } = await import('../../src/mcp/projects.js');
    const proj = await resolveProjectByName(seeded.id);
    expect(proj?.id).toBe(seeded.id);
    expect(proj?.api_key).toBe(seeded.api_key);
    expect(calls).toHaveLength(0);
  });
});

describe('resolveProjectByName — API fallback path', () => {
  beforeEach(async () => {
    // Initialize an empty master DB so getProjectByName/getProjectById
    // don't throw — they just return undefined and trigger the fallback.
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-mcp-proj-empty-'));
    const { initMasterDatabase } = await import('../../src/server/db.js');
    initMasterDatabase(tmp);
  });

  const remoteProjects = [
    {
      id: '066ccd5a-d45f-4b90-be60-3507f459f655',
      name: 'Zeno',
      github_owner: 'EpitechAfrik',
      github_repo: 'Zeno',
      api_key: 'dp_zeno_remote'
    },
    {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      name: 'EDMS',
      github_owner: 'EpitechAfrik',
      github_repo: 'edms',
      api_key: 'dp_edms_remote'
    }
  ];

  it('falls back to /api/admin/projects when SQLite has no row, matching by name', async () => {
    const calls = mockFetchSequence([
      () => new Response(JSON.stringify({ projects: remoteProjects }), { status: 200 })
    ]);
    const { resolveProjectByName } = await import('../../src/mcp/projects.js');
    const proj = await resolveProjectByName('Zeno');
    expect(proj?.id).toBe('066ccd5a-d45f-4b90-be60-3507f459f655');
    expect(proj?.api_key).toBe('dp_zeno_remote');
    expect(calls[0].url).toBe('https://api.test/api/admin/projects');
    expect(calls[0].headers['X-Admin-Key']).toBe('admin-tok');
  });

  it('falls back to /api/admin/projects when SQLite has no row, matching by UUID', async () => {
    mockFetchSequence([
      () => new Response(JSON.stringify({ projects: remoteProjects }), { status: 200 })
    ]);
    const { resolveProjectByName } = await import('../../src/mcp/projects.js');
    const proj = await resolveProjectByName('066ccd5a-d45f-4b90-be60-3507f459f655');
    expect(proj?.name).toBe('Zeno');
    expect(proj?.api_key).toBe('dp_zeno_remote');
  });

  it('returns null when the API has no matching project', async () => {
    mockFetchSequence([
      () => new Response(JSON.stringify({ projects: remoteProjects }), { status: 200 })
    ]);
    const { resolveProjectByName } = await import('../../src/mcp/projects.js');
    const proj = await resolveProjectByName('Unknown');
    expect(proj).toBeNull();
  });

  it('returns null (not throws) when ADMIN_API_KEY is missing and SQLite has no row', async () => {
    delete process.env.ADMIN_API_KEY;
    const calls = mockFetchSequence([]);
    const { resolveProjectByName } = await import('../../src/mcp/projects.js');
    const proj = await resolveProjectByName('Zeno');
    expect(proj).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null on bad input', async () => {
    const { resolveProjectByName } = await import('../../src/mcp/projects.js');
    expect(await resolveProjectByName('')).toBeNull();
    expect(await resolveProjectByName(null)).toBeNull();
    expect(await resolveProjectByName(undefined)).toBeNull();
  });
});

describe('projectFetch', () => {
  const proj = { id: 'pid', name: 'Zeno', api_key: 'dp_zeno_remote' };

  it('GETs /api<path> with X-API-Key and returns parsed JSON', async () => {
    const calls = mockFetchSequence([
      () => new Response(JSON.stringify({ labels: ['com', 'pedago'] }), { status: 200 })
    ]);
    const { projectFetch } = await import('../../src/mcp/projects.js');
    const r = await projectFetch(proj, '/team/labels');
    expect(calls[0].url).toBe('https://api.test/api/team/labels');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers['X-API-Key']).toBe('dp_zeno_remote');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(r).toEqual({ ok: true, status: 200, data: { labels: ['com', 'pedago'] } });
  });

  it('forwards method + body for POST', async () => {
    const calls = mockFetchSequence([
      () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    ]);
    const { projectFetch } = await import('../../src/mcp/projects.js');
    await projectFetch(proj, '/captures/abc/route', {
      method: 'POST',
      body: JSON.stringify({ label: 'pedago' })
    });
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body)).toEqual({ label: 'pedago' });
  });

  it('returns ok=false with parsed error body on non-2xx', async () => {
    mockFetchSequence([
      () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    ]);
    const { projectFetch } = await import('../../src/mcp/projects.js');
    const r = await projectFetch(proj, '/team/labels');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(r.data).toEqual({ error: 'not found' });
  });

  it('throws when proj has no api_key', async () => {
    const { projectFetch } = await import('../../src/mcp/projects.js');
    await expect(projectFetch({ id: 'pid' }, '/team/labels')).rejects.toThrow(/api_key/);
  });

  it('handles empty body without crashing', async () => {
    mockFetchSequence([
      () => new Response(null, { status: 204 })
    ]);
    const { projectFetch } = await import('../../src/mcp/projects.js');
    const r = await projectFetch(proj, '/team/labels');
    expect(r.ok).toBe(true);
    expect(r.status).toBe(204);
    expect(r.data).toBeNull();
  });
});
