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
