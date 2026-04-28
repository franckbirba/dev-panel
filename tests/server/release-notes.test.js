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
