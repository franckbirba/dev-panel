// Tests for the cross-project capture list (DEVPA: list_captures MCP tool).
//
// Three layers, three assertions:
//   1. listCapturesAdmin filter — pure SQLite, project_id/status/kind passthrough.
//   2. GET /api/admin/captures — admin auth + filter wiring + return shape.
//   3. list_captures MCP tool — fetch is mocked, assert URL params + shape
//      mapping match what Shelly / ephemeral agents will actually receive.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import {
  initMasterDatabase,
  createProject,
  closeAllDatabases
} from '../../src/server/db.js';
import { createCapture, listCapturesAdmin } from '../../src/server/captures.js';
import { createRouter } from '../../src/server/routes.js';

vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ getJobs: async () => [], add: async () => ({}) }),
  QUEUES: { agent: 'agent' }
}));

describe('listCapturesAdmin (function)', () => {
  let tmp, projA, projB;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-listcap-'));
    initMasterDatabase(tmp);
    projA = createProject({ name: 'alpha', github_owner: 'o', github_repo: 'a' });
    projB = createProject({ name: 'beta',  github_owner: 'o', github_repo: 'b' });
    createCapture({ project_id: projA.id, content: 'bug A1', kind: 'bug' });
    createCapture({ project_id: projA.id, content: 'idea A2', kind: 'idea' });
    createCapture({ project_id: projB.id, content: 'bug B1', kind: 'bug' });
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns every capture across projects when no project_id', () => {
    const rows = listCapturesAdmin({});
    expect(rows).toHaveLength(3);
    expect(rows.every(r => 'project_name' in r)).toBe(true);
  });

  it('filters by project_id', () => {
    const rows = listCapturesAdmin({ project_id: projB.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe(projB.id);
    expect(rows[0].project_name).toBe('beta');
  });

  it('filters by kind', () => {
    const rows = listCapturesAdmin({ kind: 'bug' });
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.content).sort()).toEqual(['bug A1', 'bug B1']);
  });

  it('filters by status (default new is correct for fresh captures)', () => {
    const rows = listCapturesAdmin({ status: 'new' });
    expect(rows).toHaveLength(3);
    expect(listCapturesAdmin({ status: 'promoted' })).toHaveLength(0);
  });

  it('respects limit', () => {
    const rows = listCapturesAdmin({ limit: 2 });
    expect(rows).toHaveLength(2);
  });
});

describe('GET /api/admin/captures', () => {
  let tmp, projA, projB, app;
  const ADMIN = 'admin-key-test';

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN;
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-listcap-r-'));
    initMasterDatabase(tmp);
    projA = createProject({ name: 'alpha', github_owner: 'o', github_repo: 'a' });
    projB = createProject({ name: 'beta',  github_owner: 'o', github_repo: 'b' });
    createCapture({ project_id: projA.id, content: 'bug A1', kind: 'bug' });
    createCapture({ project_id: projA.id, content: 'idea A2', kind: 'idea' });
    createCapture({ project_id: projB.id, content: 'bug B1', kind: 'bug' });
    app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', createRouter({ storagePath: tmp }));
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('rejects requests without X-Admin-Key', async () => {
    const res = await request(app).get('/api/admin/captures');
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(500);
  });

  it('returns all captures when no filters set', async () => {
    const res = await request(app)
      .get('/api/admin/captures')
      .set('X-Admin-Key', ADMIN);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.captures)).toBe(true);
    expect(res.body.captures).toHaveLength(3);
  });

  it('forwards project_id + kind filters to listCapturesAdmin', async () => {
    const res = await request(app)
      .get(`/api/admin/captures?project_id=${projA.id}&kind=bug`)
      .set('X-Admin-Key', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.captures).toHaveLength(1);
    expect(res.body.captures[0].project_id).toBe(projA.id);
    expect(res.body.captures[0].kind).toBe('bug');
  });

  it('clamps limit to 200 max', async () => {
    const res = await request(app)
      .get('/api/admin/captures?limit=999')
      .set('X-Admin-Key', ADMIN);
    expect(res.status).toBe(200);
    // Only 3 captures seeded so we can't observe the cap directly, but the
    // request must not 400 — same shape as ?limit=2 (truncating) below.
    expect(res.body.captures.length).toBeLessThanOrEqual(3);
  });
});

describe('list_captures MCP tool', () => {
  const ORIGINAL_ENV = { ...process.env };
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-listcap-mcp-'));
    process.env = {
      ...ORIGINAL_ENV,
      MCP_NO_AUTOSTART: '1',
      DEVPANEL_STORAGE: tmp,
      API_BASE: 'https://api.test',
      ADMIN_API_KEY: 'admin-tok'
    };
    delete process.env.PLANE_SHELLY_EMAIL;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('is registered in the default MCP profile', async () => {
    const mod = await import('../../src/mcp/server.js');
    expect(mod.getRegisteredToolNames()).toContain('list_captures');
  });

  it('GETs /api/admin/captures with X-Admin-Key + filter params and reshapes the rows', async () => {
    const apiRows = [
      {
        id: 'cap-1',
        project_id: 'proj-uuid',
        project_name: 'alpha',
        kind: 'bug',
        status: 'new',
        content: 'oops',
        environment: 'production',
        reporter: { id: 'u1', name: 'someone' },
        created_at: '2026-05-09T00:00:00Z',
        plane_work_item_id: null,
        plane_sequence_id: null,
        // surplus fields the wrapper should drop:
        reporter_id: 'u1', updated_at: 'anything', message_count: 0
      }
    ];
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers || {} });
      return new Response(JSON.stringify({ captures: apiRows }), { status: 200 });
    });

    const { server } = await import('../../src/mcp/server.js');
    const tools = server._registeredTools || server.registeredTools || {};
    const tool = tools.list_captures;
    expect(tool, 'list_captures must be registered on the MCP server').toBeTruthy();

    const handler = tool.callback || tool.handler;
    const result = await handler({ status: 'new', kind: 'bug', project_id: 'proj-uuid', limit: 25 });

    expect(calls).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe('https://api.test/api/admin/captures');
    expect(u.searchParams.get('project_id')).toBe('proj-uuid');
    expect(u.searchParams.get('status')).toBe('new');
    expect(u.searchParams.get('kind')).toBe('bug');
    expect(u.searchParams.get('limit')).toBe('25');
    expect(calls[0].headers['X-Admin-Key']).toBe('admin-tok');

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toHaveLength(1);
    expect(payload[0]).toEqual({
      id: 'cap-1',
      project_id: 'proj-uuid',
      project_name: 'alpha',
      kind: 'bug',
      status: 'new',
      content: 'oops',
      environment: 'production',
      reporter: { id: 'u1', name: 'someone' },
      created_at: '2026-05-09T00:00:00Z',
      plane_work_item_id: null,
      plane_sequence_id: null
    });
  });

  it('returns an isError content when ADMIN_API_KEY is missing', async () => {
    delete process.env.ADMIN_API_KEY;
    const { server } = await import('../../src/mcp/server.js');
    const tools = server._registeredTools || server.registeredTools || {};
    const tool = tools.list_captures;
    const handler = tool.callback || tool.handler;
    const result = await handler({ status: 'new', limit: 50 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/ADMIN_API_KEY/);
  });
});
