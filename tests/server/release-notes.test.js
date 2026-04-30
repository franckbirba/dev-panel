import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../../src/server/pg.js', () => ({
  pool: { query: (...args) => queryMock(...args) }
}));

import { recordBroadcast } from '../../src/server/release-notes.js';

describe('recordBroadcast', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns inserted=true when the row is new', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ synthetic_id: 'github:owner/repo#42:merged' }] });
    const r = await recordBroadcast('github:owner/repo#42:merged');
    expect(r).toEqual({ inserted: true });
    expect(queryMock).toHaveBeenCalledOnce();
    const sql = queryMock.mock.calls[0][0];
    expect(sql).toMatch(/INSERT INTO release_broadcasts/);
    expect(sql).toMatch(/ON CONFLICT.*DO NOTHING/i);
    expect(sql).toMatch(/RETURNING/i);
    expect(queryMock.mock.calls[0][1]).toEqual(['github:owner/repo#42:merged']);
  });

  it('returns inserted=false when the row already existed', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const r = await recordBroadcast('github:owner/repo#42:merged');
    expect(r).toEqual({ inserted: false });
  });
});

import { buildReleaseNote } from '../../src/server/release-notes.js';

describe('buildReleaseNote', () => {
  const pr = {
    number: 42,
    title: 'Flight-deck Phase 5',
    user: { login: 'franckbirba' },
    changed_files: 17,
    additions: 482,
    deletions: 103
  };
  const repo = 'franckbirba/dev-panel';
  const commits = [
    { sha: 'a284af8aaa', commit: { message: 'fix(flight-deck): real Approve/Retry/Reply actions\n\nbody ignored' } },
    { sha: '364593dbbb', commit: { message: 'Inbox / Fleet / Memory + real liveness' } }
  ];

  it('formats header, author, stats and commit bullets', () => {
    const note = buildReleaseNote({ pr, repo, commits, cycle: null });
    expect(note).toContain('Merged — franckbirba/dev-panel #42: Flight-deck Phase 5');
    expect(note).toContain('by @franckbirba');
    expect(note).toContain('17 files, +482/-103');
    expect(note).toContain('• a284af8 fix(flight-deck): real Approve/Retry/Reply actions');
    expect(note).toContain('• 364593d Inbox / Fleet / Memory + real liveness');
    expect(note).not.toContain('body ignored');
    expect(note).not.toMatch(/Cycle:/);
  });

  it('caps commits at 8 and appends "(+N more)"', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      sha: String(i).padStart(10, '0'),
      commit: { message: `commit ${i}` }
    }));
    const note = buildReleaseNote({ pr, repo, commits: many, cycle: null });
    const bullets = note.split('\n').filter(l => l.startsWith('• '));
    expect(bullets).toHaveLength(8);
    expect(note).toContain('(+3 more)');
  });

  it('shows "(commits unavailable)" when commits is null', () => {
    const note = buildReleaseNote({ pr, repo, commits: null, cycle: null });
    expect(note).toContain('(commits unavailable)');
    expect(note).not.toMatch(/^•/m);
  });

  it('appends Cycle line when cycle is provided', () => {
    const cycle = { name: 'Sprint 14', url: 'https://plane.devpanl.dev/devpanl/projects/abc/cycles/xyz/' };
    const note = buildReleaseNote({ pr, repo, commits, cycle });
    expect(note).toContain('Cycle: Sprint 14 — https://plane.devpanl.dev/devpanl/projects/abc/cycles/xyz/');
  });

  it('omits Cycle line when cycle is null', () => {
    const note = buildReleaseNote({ pr, repo, commits, cycle: null });
    expect(note).not.toMatch(/Cycle:/);
  });
});

import { fetchCommits } from '../../src/server/release-notes.js';

describe('fetchCommits', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    process.env.GITHUB_TOKEN = 'test-token';
  });

  it('returns the commits array on 2xx', async () => {
    const fixture = [{ sha: 'aaa', commit: { message: 'a' } }];
    fetch.mockResolvedValueOnce({ ok: true, json: async () => fixture });
    const r = await fetchCommits('owner/repo', 42);
    expect(r).toEqual(fixture);
    const call = fetch.mock.calls[0];
    expect(call[0]).toBe('https://api.github.com/repos/owner/repo/pulls/42/commits?per_page=100');
    expect(call[1].headers.Authorization).toBe('Bearer test-token');
    expect(call[1].headers.Accept).toBe('application/vnd.github+json');
  });

  it('returns null on non-2xx', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const r = await fetchCommits('owner/repo', 42);
    expect(r).toBeNull();
  });

  it('returns null on network failure', async () => {
    fetch.mockRejectedValueOnce(new Error('boom'));
    const r = await fetchCommits('owner/repo', 42);
    expect(r).toBeNull();
  });
});

const listActiveMock = vi.fn();
vi.mock('../../src/server/dev-bots.js', () => ({
  listActive: (...a) => listActiveMock(...a)
}));

import { resolveCycle } from '../../src/server/release-notes.js';

describe('resolveCycle', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    process.env.PLANE_API_TOKEN = 'plane-tok';
    process.env.PLANE_WORKSPACE_SLUG = 'devpanl';
    process.env.PLANE_BASE_URL = 'https://plane.devpanl.dev';
  });

  it('returns null when planeRef is null', async () => {
    expect(await resolveCycle(null)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns null when no projects match the sequence prefix', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
      { id: 'p1', identifier: 'ZENO' }
    ] }) });
    const r = await resolveCycle({ type: 'sequence', project: 'DEVPA', number: 93 });
    expect(r).toBeNull();
  });

  it('returns null when there is no active cycle', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
        { id: 'p1', identifier: 'DEVPA' }
      ] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    const r = await resolveCycle({ type: 'sequence', project: 'DEVPA', number: 93 });
    expect(r).toBeNull();
  });

  it('returns {name, url} when an active cycle exists', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
        { id: 'p1', identifier: 'DEVPA' }
      ] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
        { id: 'c1', name: 'Sprint 14' }
      ] }) });
    const r = await resolveCycle({ type: 'sequence', project: 'DEVPA', number: 93 });
    expect(r).toEqual({
      name: 'Sprint 14',
      url: 'https://plane.devpanl.dev/devpanl/projects/p1/cycles/c1/'
    });
  });

  it('returns null when the projects fetch throws', async () => {
    fetch.mockRejectedValueOnce(new Error('plane down'));
    const r = await resolveCycle({ type: 'sequence', project: 'DEVPA', number: 93 });
    expect(r).toBeNull();
  });

  it('walks projects to find the host of a uuid ref, then returns the active cycle', async () => {
    const uuid = '7096cee4-889b-403d-b924-2ad2dfbf371c';
    fetch
      // 1) list projects
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
        { id: 'p1', identifier: 'ZENO' },
        { id: 'p2', identifier: 'DEVPA' }
      ] }) })
      // 2) probe p1 — 404
      .mockResolvedValueOnce({ ok: false, status: 404 })
      // 3) probe p2 — 200, this is the host
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: uuid }) })
      // 4) active cycle on p2
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
        { id: 'cyc-9', name: 'Sprint 21' }
      ] }) });

    const r = await resolveCycle({ type: 'uuid', value: uuid });
    expect(r).toEqual({
      name: 'Sprint 21',
      url: 'https://plane.devpanl.dev/devpanl/projects/p2/cycles/cyc-9/'
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

import { fanOut } from '../../src/server/release-notes.js';

describe('fanOut', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    listActiveMock.mockReset();
  });

  it('sends one Telegram message per bot with owner_tg_user_id', async () => {
    listActiveMock.mockResolvedValueOnce([
      { bot_token: 'tok-a', owner_tg_user_id: 111 },
      { bot_token: 'tok-b', owner_tg_user_id: 222 }
    ]);
    fetch.mockResolvedValue({ ok: true });

    await fanOut('hello team');

    expect(fetch).toHaveBeenCalledTimes(2);
    const urls = fetch.mock.calls.map(c => c[0]);
    expect(urls).toContain('https://api.telegram.org/bottok-a/sendMessage');
    expect(urls).toContain('https://api.telegram.org/bottok-b/sendMessage');
    const bodies = fetch.mock.calls.map(c => JSON.parse(c[1].body));
    expect(bodies).toEqual(expect.arrayContaining([
      { chat_id: 111, text: 'hello team' },
      { chat_id: 222, text: 'hello team' }
    ]));
  });

  it('skips bots without owner_tg_user_id', async () => {
    listActiveMock.mockResolvedValueOnce([
      { bot_token: 'tok-a', owner_tg_user_id: null },
      { bot_token: 'tok-b', owner_tg_user_id: 222 }
    ]);
    fetch.mockResolvedValue({ ok: true });

    await fanOut('hi');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain('tok-b');
  });

  it('does not throw when one bot fails', async () => {
    listActiveMock.mockResolvedValueOnce([
      { bot_token: 'tok-a', owner_tg_user_id: 111 },
      { bot_token: 'tok-b', owner_tg_user_id: 222 }
    ]);
    fetch
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true });

    await expect(fanOut('hi')).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns early when no active bots', async () => {
    listActiveMock.mockResolvedValueOnce([]);
    await fanOut('hi');
    expect(fetch).not.toHaveBeenCalled();
  });
});

import { broadcastRelease } from '../../src/server/release-notes.js';

describe('broadcastRelease', () => {
  const pr = {
    number: 42,
    title: 'Test PR',
    user: { login: 'me' },
    changed_files: 1, additions: 1, deletions: 0,
    head: { ref: 'feat/wi-7096cee4-foo-bar' }
  };

  beforeEach(() => {
    queryMock.mockReset();
    listActiveMock.mockReset();
    vi.stubGlobal('fetch', vi.fn());
    process.env.GITHUB_TOKEN = 'gh';
    process.env.PLANE_API_TOKEN = 'p';
  });

  it('inserts the broadcast row, fetches commits, and fans out', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ synthetic_id: 'github:owner/repo#42:merged' }] });
    fetch.mockResolvedValueOnce({ ok: true, json: async () => [
      { sha: 'abc1234', commit: { message: 'a' } }
    ] });
    // resolveCycle: projects fetch returns no match → null cycle
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    listActiveMock.mockResolvedValueOnce([{ bot_token: 't', owner_tg_user_id: 1 }]);
    fetch.mockResolvedValueOnce({ ok: true });

    const r = await broadcastRelease({ repo: 'owner/repo', pr });
    expect(r).toEqual({ broadcast: true });

    const tgCall = fetch.mock.calls.find(c => c[0].includes('api.telegram.org'));
    expect(tgCall).toBeDefined();
    const text = JSON.parse(tgCall[1].body).text;
    expect(text).toContain('Merged — owner/repo #42: Test PR');
    expect(text).toContain('• abc1234 a');
  });

  it('short-circuits when recordBroadcast says replay', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const r = await broadcastRelease({ repo: 'owner/repo', pr });
    expect(r).toEqual({ broadcast: false, reason: 'replay' });
    expect(fetch).not.toHaveBeenCalled();
    expect(listActiveMock).not.toHaveBeenCalled();
  });

  it('renders the Cycle line when planeRef matches and active cycle exists', async () => {
    const prWithSeqBranch = {
      ...pr,
      head: { ref: 'feat/devpa-93-foo' }   // matches BRANCH_SEQ_RE → sequence ref DEVPA-93
    };

    queryMock.mockResolvedValueOnce({ rows: [{ synthetic_id: 'github:owner/repo#42:merged' }] });
    fetch
      // 1) fetchCommits → empty array is fine
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      // 2) resolveCycle: list projects → DEVPA matches
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
        { id: 'p1', identifier: 'DEVPA' }
      ] }) })
      // 3) active cycle on p1
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
        { id: 'cyc-1', name: 'Sprint 14' }
      ] }) });
    listActiveMock.mockResolvedValueOnce([{ bot_token: 't', owner_tg_user_id: 1 }]);
    fetch.mockResolvedValueOnce({ ok: true });   // 4) telegram

    const r = await broadcastRelease({ repo: 'owner/repo', pr: prWithSeqBranch });
    expect(r).toEqual({ broadcast: true });

    const tgCall = fetch.mock.calls.find(c => c[0].includes('api.telegram.org'));
    const text = JSON.parse(tgCall[1].body).text;
    expect(text).toContain('Cycle: Sprint 14 — https://plane.devpanl.dev/devpanl/projects/p1/cycles/cyc-1/');
  });
});
