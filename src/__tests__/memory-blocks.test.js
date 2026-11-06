import { describe, it, beforeEach, afterEach } from 'node:test';
import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { pool } from '../server/pg.js';
import { getMemoryBlocksForNamespace } from '../server/pg.js';

describe('Memory Blocks', () => {
  beforeEach(async () => {
    // Clean up test data before each test
    await pool.query('DELETE FROM memory_blocks WHERE namespace = $1', ['test-namespace']);
  });

  afterEach(async () => {
    // Clean up test data after each test
    await pool.query('DELETE FROM memory_blocks WHERE namespace = $1', ['test-namespace']);
  });

  describe('getMemoryBlocksForNamespace', () => {
    it('should return empty array when no blocks exist', async () => {
      const blocks = await getMemoryBlocksForNamespace('nonexistent-namespace');
      deepStrictEqual(blocks, []);
    });

    it('should return memory blocks when they exist', async () => {
      // Insert test data
      await pool.query(
        `INSERT INTO memory_blocks (namespace, block_name, content, char_limit) 
         VALUES ($1, $2, $3, $4)`,
        ['test-namespace', 'test-block', 'Test content', 1000]
      );

      const blocks = await getMemoryBlocksForNamespace('test-namespace');
      strictEqual(blocks.length, 1);
      strictEqual(blocks[0].block_name, 'test-block');
      strictEqual(blocks[0].content, 'Test content');
      strictEqual(blocks[0].char_limit, 1000);
    });

    it('should return multiple memory blocks ordered by name', async () => {
      // Insert test data
      await pool.query(
        `INSERT INTO memory_blocks (namespace, block_name, content, char_limit) 
         VALUES 
         ($1, $2, $3, $4),
         ($5, $6, $7, $8)`,
        [
          'test-namespace', 'b-block', 'Content B', 1000,
          'test-namespace', 'a-block', 'Content A', 1000
        ]
      );

      const blocks = await getMemoryBlocksForNamespace('test-namespace');
      strictEqual(blocks.length, 2);
      // Should be ordered by block_name
      strictEqual(blocks[0].block_name, 'a-block');
      strictEqual(blocks[1].block_name, 'b-block');
    });
  });
});