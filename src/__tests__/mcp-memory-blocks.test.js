import { describe, it, beforeEach, afterEach } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { buildServer } from '../mcp/server.js';

describe('MCP Memory Blocks Tools', () => {
  let server;

  beforeEach(async () => {
    // Create a fresh server instance for each test
    server = buildServer();
    
    // Clean up test data
    const { pool } = await import('../server/pg.js');
    await pool.query('DELETE FROM memory_blocks WHERE namespace = $1', ['test-namespace']);
  });

  afterEach(async () => {
    // Clean up test data
    const { pool } = await import('../server/pg.js');
    await pool.query('DELETE FROM memory_blocks WHERE namespace = $1', ['test-namespace']);
  });

  describe('memory_block_write', () => {
    it('should create a new memory block', async () => {
      const result = await server.callTool('memory_block_write', {
        block_name: 'test-block',
        content: 'Test content'
      });

      ok(result.content);
      const response = JSON.parse(result.content[0].text);
      ok(response.success);
      ok(response.id);
      strictEqual(response.block_name, 'test-block');
      strictEqual(response.content_length, 12);
    });

    it('should update an existing memory block', async () => {
      // Create initial block
      await server.callTool('memory_block_write', {
        block_name: 'test-block',
        content: 'Initial content'
      });

      // Update the block
      const result = await server.callTool('memory_block_write', {
        block_name: 'test-block',
        content: 'Updated content'
      });

      ok(result.content);
      const response = JSON.parse(result.content[0].text);
      ok(response.success);
      strictEqual(response.block_name, 'test-block');
      strictEqual(response.content_length, 15);
    });

    it('should reject content that exceeds character limit', async () => {
      const longContent = 'A'.repeat(2500); // Exceeds default limit of 2000
      
      const result = await server.callTool('memory_block_write', {
        block_name: 'test-block',
        content: longContent
      });

      ok(result.isError);
      const response = JSON.parse(result.content[0].text);
      ok(response.error);
    });
  });

  describe('memory_block_read', () => {
    it('should read an existing memory block', async () => {
      // Create a block first
      await server.callTool('memory_block_write', {
        block_name: 'test-block',
        content: 'Test content'
      });

      const result = await server.callTool('memory_block_read', {
        block_name: 'test-block'
      });

      ok(result.content);
      const response = JSON.parse(result.content[0].text);
      ok(response.found);
      strictEqual(response.block_name, 'test-block');
      strictEqual(response.content, 'Test content');
    });

    it('should return not found for non-existent block', async () => {
      const result = await server.callTool('memory_block_read', {
        block_name: 'nonexistent-block'
      });

      ok(result.content);
      const response = JSON.parse(result.content[0].text);
      strictEqual(response.found, false);
    });
  });

  describe('memory_block_list', () => {
    it('should list all memory blocks in namespace', async () => {
      // Create some blocks
      await server.callTool('memory_block_write', {
        block_name: 'block-a',
        content: 'Content A'
      });

      await server.callTool('memory_block_write', {
        block_name: 'block-b',
        content: 'Content B'
      });

      const result = await server.callTool('memory_block_list', {});

      ok(result.content);
      const response = JSON.parse(result.content[0].text);
      ok(Array.isArray(response.blocks));
      strictEqual(response.blocks.length, 2);
      
      // Should be ordered by block_name
      strictEqual(response.blocks[0].block_name, 'block-a');
      strictEqual(response.blocks[1].block_name, 'block-b');
    });

    it('should return empty array when no blocks exist', async () => {
      const result = await server.callTool('memory_block_list', {});

      ok(result.content);
      const response = JSON.parse(result.content[0].text);
      ok(Array.isArray(response.blocks));
      strictEqual(response.blocks.length, 0);
    });
  });
});