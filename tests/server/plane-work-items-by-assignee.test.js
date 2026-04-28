import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    PLANE_BASE_URL: 'https://plane.test',
    PLANE_WORKSPACE_SLUG: 'devpanl',
    PLANE_API_KEY: 'test-key'
  };
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

// --- Mock data ---
const PROJECTS = [
  { id: 'proj-zeno', identifier: 'ZENO', name: 'Zeno' },
  { id: 'proj-devpa', identifier: 'DEVPA', name: 'DevPanel' }
];

const MEMBERS = [
  { member: { id: 'user-edwin', email: 'edwin1.kouassi@example.com', display_name: 'Edwin', first_name: 'Edwin' } },
  { member: { id: 'user-franck', email: 'franck@example.com', display_name: 'Franck', first_name: 'Franck' } }
];

const ISSUES = [
  { id: 'issue-1', sequence_id: 42, name: 'Fix pagination', state: 'state-started', assignee_ids: ['user-edwin'], priority: 'high', updated_at: '2026-04-27T12:00:00Z' },
  { id: 'issue-2', sequence_id: 43, name: 'Add dark mode', state: 'state-backlog', assignee_ids: ['user-franck'], priority: 'medium', updated_at: '2026-04-26T12:00:00Z' },
  { id: 'issue-3', sequence_id: 44, name: 'Fix auth bug', state: 'state-started', assignee_ids: ['user-edwin'], priority: 'urgent', updated_at: '2026-04-28T12:00:00Z' }
];

const STATES = [
  { id: 'state-started', group: 'started', name: 'In Progress' },
  { id: 'state-backlog', group: 'backlog', name: 'Backlog' }
];

function mockFetch(opts = {}) {
  return vi.fn(async (url) => {
    if (url.includes('/projects/') && url.endsWith('/projects/')) {
      return new Response(JSON.stringify({ results: PROJECTS }), { status: 200 });
    }
    if (url.includes('/members/')) {
      return new Response(JSON.stringify({ results: MEMBERS }), { status: 200 });
    }
    if (url.includes('/states/')) {
      return new Response(JSON.stringify({ results: STATES }), { status: 200 });
    }
    if (url.includes('/issues/')) {
      const u = new URL(url);
      const assigneeFilter = u.searchParams.get('assignees');
      if (assigneeFilter && !opts.ignoreAssigneesParam) {
        const filtered = ISSUES.filter(i => i.assignee_ids.includes(assigneeFilter));
        return new Response(JSON.stringify({ results: filtered }), { status: 200 });
      }
      return new Response(JSON.stringify({ results: ISSUES }), { status: 200 });
    }
    throw new Error('unexpected url: ' + url);
  });
}

describe('plane-work-items — resolveProjectId', () => {
  it('resolves identifier to UUID', async () => {
    globalThis.fetch = mockFetch();
    const { __internal } = await import('../../src/mcp/plane-work-items.js');
    const id = await __internal.resolveProjectId('ZENO', {
      base: 'https://plane.test', slug: 'devpanl', key: 'test-key'
    });
    expect(id).toBe('proj-zeno');
  });

  it('passes through a UUID unchanged', async () => {
    const { __internal } = await import('../../src/mcp/plane-work-items.js');
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const id = await __internal.resolveProjectId(uuid, {
      base: 'https://plane.test', slug: 'devpanl', key: 'test-key'
    });
    expect(id).toBe(uuid);
  });

  it('throws on unknown identifier', async () => {
    globalThis.fetch = mockFetch();
    const { __internal } = await import('../../src/mcp/plane-work-items.js');
    await expect(__internal.resolveProjectId('NOPE', {
      base: 'https://plane.test', slug: 'devpanl', key: 'test-key'
    })).rejects.toThrow(/No Plane project matches "NOPE"/);
  });
});

describe('plane-work-items — resolveAssigneeId', () => {
  it('resolves by email (case-insensitive)', async () => {
    globalThis.fetch = mockFetch();
    const { __internal } = await import('../../src/mcp/plane-work-items.js');
    const id = await __internal.resolveAssigneeId('Edwin1.Kouassi@example.com', {
      base: 'https://plane.test', slug: 'devpanl', key: 'test-key'
    });
    expect(id).toBe('user-edwin');
  });

  it('resolves by display_name (case-insensitive)', async () => {
    globalThis.fetch = mockFetch();
    const { __internal } = await import('../../src/mcp/plane-work-items.js');
    const id = await __internal.resolveAssigneeId('edwin', {
      base: 'https://plane.test', slug: 'devpanl', key: 'test-key'
    });
    expect(id).toBe('user-edwin');
  });

  it('passes through a UUID unchanged', async () => {
    const { __internal } = await import('../../src/mcp/plane-work-items.js');
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const id = await __internal.resolveAssigneeId(uuid, {
      base: 'https://plane.test', slug: 'devpanl', key: 'test-key'
    });
    expect(id).toBe(uuid);
  });

  it('throws on unknown assignee', async () => {
    globalThis.fetch = mockFetch();
    const { __internal } = await import('../../src/mcp/plane-work-items.js');
    await expect(__internal.resolveAssigneeId('nobody@example.com', {
      base: 'https://plane.test', slug: 'devpanl', key: 'test-key'
    })).rejects.toThrow(/No workspace member matches/);
  });
});

describe('plane-work-items — listWorkItemsByAssignee', () => {
  it('returns items assigned to Edwin on ZENO (server-side filter)', async () => {
    globalThis.fetch = mockFetch();
    const { listWorkItemsByAssignee } = await import('../../src/mcp/plane-work-items.js');
    const items = await listWorkItemsByAssignee({ project: 'ZENO', assignee: 'edwin' });
    expect(items).toHaveLength(2);
    expect(items.every(i => i.assignee_ids.includes('user-edwin'))).toBe(true);
    expect(items[0]).toMatchObject({
      id: expect.any(String),
      sequence_id: expect.any(Number),
      name: expect.any(String),
      state_id: expect.any(String),
      url: expect.stringContaining('/projects/proj-zeno/issues/')
    });
  });

  it('falls back to client-side filter when server ignores ?assignees=', async () => {
    globalThis.fetch = mockFetch({ ignoreAssigneesParam: true });
    const { listWorkItemsByAssignee } = await import('../../src/mcp/plane-work-items.js');
    const items = await listWorkItemsByAssignee({ project: 'ZENO', assignee: 'edwin' });
    expect(items).toHaveLength(2);
    expect(items.every(i => i.assignee_ids.includes('user-edwin'))).toBe(true);
  });

  it('filters by state_group', async () => {
    globalThis.fetch = mockFetch();
    const { listWorkItemsByAssignee } = await import('../../src/mcp/plane-work-items.js');
    const items = await listWorkItemsByAssignee({
      project: 'ZENO', assignee: 'franck', state_group: 'backlog'
    });
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Add dark mode');
  });

  it('respects limit', async () => {
    globalThis.fetch = mockFetch();
    const { listWorkItemsByAssignee } = await import('../../src/mcp/plane-work-items.js');
    const items = await listWorkItemsByAssignee({ project: 'ZENO', assignee: 'edwin', limit: 1 });
    expect(items).toHaveLength(1);
  });

  it('returns empty when no items match state_group', async () => {
    globalThis.fetch = mockFetch();
    const { listWorkItemsByAssignee } = await import('../../src/mcp/plane-work-items.js');
    const items = await listWorkItemsByAssignee({
      project: 'ZENO', assignee: 'franck', state_group: 'started'
    });
    expect(items).toHaveLength(0);
  });

  it('throws when PLANE_API_KEY is missing', async () => {
    delete process.env.PLANE_API_KEY;
    delete process.env.PLANE_API_TOKEN;
    const { listWorkItemsByAssignee } = await import('../../src/mcp/plane-work-items.js');
    await expect(listWorkItemsByAssignee({ project: 'ZENO', assignee: 'edwin' }))
      .rejects.toThrow(/PLANE_API_KEY/);
  });
});

describe('plane-work-items — fetchStates', () => {
  it('returns state_id to group mapping', async () => {
    globalThis.fetch = mockFetch();
    const { __internal } = await import('../../src/mcp/plane-work-items.js');
    const map = await __internal.fetchStates('proj-zeno', {
      base: 'https://plane.test', slug: 'devpanl', key: 'test-key'
    });
    expect(map).toEqual({
      'state-started': 'started',
      'state-backlog': 'backlog'
    });
  });
});
