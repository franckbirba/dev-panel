// tests/server/temporal-validity.test.js
import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import { pool, memoryInsert, memorySearchSqlWithValidity, memoryList, memorySupersede } from '../../src/server/pg.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('pg memory temporal validity (integration)', () => {
  let id1, id2;
  afterAll(async () => { await pool.end(); });

  it('inserts memory rows with temporal validity', async () => {
    // Insert first memory that is currently valid
    id1 = await memoryInsert({
      namespace: 'test-temporal',
      agent: 'builder',
      kind: 'decision',
      title: 'Current Decision',
      content: 'This is a currently valid decision',
      embedding: Array(1024).fill(0.01),
      valid_from: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
      valid_to: null // Still valid
    });
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);

    // Insert second memory that is expired
    id2 = await memoryInsert({
      namespace: 'test-temporal',
      agent: 'builder',
      kind: 'decision',
      title: 'Expired Decision',
      content: 'This is an expired decision',
      embedding: Array(1024).fill(0.02),
      valid_from: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
      valid_to: new Date(Date.now() - 3600000).toISOString() // Expired 1 hour ago
    });
    expect(id2).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('lists current memories excluding expired ones', async () => {
    const rows = await memoryList({ 
      namespace: 'test-temporal', 
      agent: 'builder', 
      limit: 10 
    });
    
    // Should only return the non-expired memory
    expect(rows.some(r => r.id === id1)).toBe(true);
    expect(rows.some(r => r.id === id2)).toBe(false);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('searches current memories excluding expired ones', async () => {
    const rows = await memorySearchSqlWithValidity({
      namespace: 'test-temporal',
      embedding: Array(1024).fill(0.01),
      limit: 10
    });
    
    // Should only return the non-expired memory
    expect(rows.some(r => r.id === id1)).toBe(true);
    expect(rows.some(r => r.id === id2)).toBe(false);
  });

  it('queries historical state with as_of parameter', async () => {
    // Query as of 30 minutes ago - should include both memories since they were both valid then
    const thirtyMinutesAgo = new Date(Date.now() - 1800000).toISOString();
    
    const rows = await memoryList({ 
      namespace: 'test-temporal', 
      agent: 'builder', 
      limit: 10,
      as_of: thirtyMinutesAgo
    });
    
    // Both memories should be returned as they were valid 30 minutes ago
    expect(rows.some(r => r.id === id1)).toBe(true);
    expect(rows.some(r => r.id === id2)).toBe(true);
  });

  it('supersedes a memory by setting valid_to', async () => {
    // Create a memory to supersede
    const originalId = await memoryInsert({
      namespace: 'test-supersede',
      agent: 'builder',
      kind: 'decision',
      title: 'Original Decision',
      content: 'This decision will be superseded',
      embedding: Array(1024).fill(0.03),
      valid_from: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
      valid_to: null // Still valid initially
    });
    
    // Supersede the memory
    await memorySupersede(originalId);
    
    // Check that the original memory is now expired
    const rows = await memoryList({ 
      namespace: 'test-supersede', 
      agent: 'builder', 
      limit: 10 
    });
    
    // The original memory should no longer appear in current queries
    expect(rows.some(r => r.id === originalId)).toBe(false);
  });
});