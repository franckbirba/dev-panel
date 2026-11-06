#!/bin/bash

# Simple test script to verify memory blocks functionality

echo "Testing memory blocks implementation..."

# Test 1: Create a memory block
echo "Test 1: Creating a memory block..."
node -e "
import { pool } from './src/server/pg.js';

async function testCreate() {
  try {
    const { rows } = await pool.query(
      \`INSERT INTO memory_blocks (namespace, block_name, content, char_limit)
       VALUES (\$1, \$2, \$3, \$4)
       ON CONFLICT (namespace, block_name) 
       DO UPDATE SET content = \$3, char_limit = \$4, updated_at = NOW()
       RETURNING id\`,
      ['test-namespace', 'test-block', 'Test content for verification', 2000]
    );
    console.log('✓ Successfully created memory block with ID:', rows[0].id);
  } catch (err) {
    console.error('✗ Failed to create memory block:', err.message);
  }
}

testCreate();
" || echo "✗ Test 1 failed"

# Test 2: Read memory blocks
echo "Test 2: Reading memory blocks..."
node -e "
import { pool } from './src/server/pg.js';

async function testRead() {
  try {
    const { rows } = await pool.query(
      'SELECT block_name, content FROM memory_blocks WHERE namespace = \$1 AND block_name = \$2',
      ['test-namespace', 'test-block']
    );
    if (rows.length > 0) {
      console.log('✓ Successfully read memory block:', rows[0].block_name);
      console.log('  Content:', rows[0].content);
    } else {
      console.log('✗ Memory block not found');
    }
  } catch (err) {
    console.error('✗ Failed to read memory block:', err.message);
  }
}

testRead();
" || echo "✗ Test 2 failed"

# Test 3: List memory blocks
echo "Test 3: Listing memory blocks..."
node -e "
import { pool } from './src/server/pg.js';

async function testList() {
  try {
    const { rows } = await pool.query(
      'SELECT block_name FROM memory_blocks WHERE namespace = \$1 ORDER BY block_name',
      ['test-namespace']
    );
    console.log('✓ Found', rows.length, 'memory blocks:');
    rows.forEach(row => console.log('  -', row.block_name));
  } catch (err) {
    console.error('✗ Failed to list memory blocks:', err.message);
  }
}

testList();
" || echo "✗ Test 3 failed"

echo "Memory blocks tests completed."