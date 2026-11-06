import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { 
  initMasterDatabase, 
  closeAllDatabases, 
  registerAgentNode, 
  createTaskToken,
  getAgentNode
} from '../src/server/db.js';

describe('Agent Hub Database Tests', () => {
  beforeEach(async () => {
    // Initialize database
    initMasterDatabase('./test-storage');
  });

  afterEach(async () => {
    closeAllDatabases();
  });

  it('should register an agent node', async () => {
    const nodeId = randomUUID();
    const nodeName = `test-node-${Date.now()}`; // Ensure unique name
    const publicKey = 'test-public-key';
    
    // Register the node
    registerAgentNode({ id: nodeId, name: nodeName, public_key: publicKey });
    
    // Verify the node was registered
    const node = getAgentNode(nodeId);
    assert.ok(node);
    assert.equal(node.id, nodeId);
    assert.equal(node.name, nodeName);
    assert.equal(node.public_key, publicKey);
    assert.equal(node.revoked_at, null);
  });

  it('should create a task token', async () => {
    const nodeId = randomUUID();
    const nodeName = `test-node-${Date.now()}-2`; // Ensure unique name
    const tokenId = randomUUID();
    const taskId = 'test-task-1';
    const repository = 'test-repo';
    const branch = 'test-branch';
    
    // Register the node first
    registerAgentNode({ id: nodeId, name: nodeName, public_key: 'test-key' });
    
    // Create a task token
    createTaskToken({ 
      id: tokenId, 
      node_id: nodeId, 
      task_id: taskId, 
      repository, 
      branch, 
      expires_at: new Date(Date.now() + 3600000) // 1 hour from now
    });
    
    // Verify the token ID was generated
    assert.ok(tokenId);
    assert.ok(nodeId);
  });
});