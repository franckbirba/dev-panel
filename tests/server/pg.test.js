// tests/server/pg.test.js
import { describe, it, expect, afterAll } from 'vitest';
import { pool, memoryInsert, memorySearchSql, memoryList } from '../../src/server/pg.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('pg memory helpers (integration)', () => {
  let id;
  afterAll(async () => { await pool.end(); });

  it('inserts a memory row', async () => {
    id = await memoryInsert({
      namespace: 'test',
      agent: 'builder',
      kind: 'decision',
      title: 't1',
      content: 'c1',
      embedding: Array(1024).fill(0.01)
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('lists by namespace+agent', async () => {
    const rows = await memoryList({ namespace: 'test', agent: 'builder', limit: 5 });
    expect(rows.some(r => r.id === id)).toBe(true);
  });

  it('searches by vector similarity', async () => {
    const rows = await memorySearchSql({
      namespace: 'test',
      embedding: Array(1024).fill(0.01),
      limit: 3
    });
    expect(rows[0].id).toBe(id);
    expect(typeof rows[0].score).toBe('number');
  });
});
