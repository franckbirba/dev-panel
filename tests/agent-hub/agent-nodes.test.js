import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { 
  initMasterDatabase, 
  closeAllDatabases,
  registerAgentNode,
  getAgentNode,
  getAgentNodeByToken,
  revokeAgentNode,
  updateAgentNodeLastSeen
} from '../../src/server/db.js';
import { randomUUID } from 'crypto';

describe('Agent Nodes', () => {
  let testStoragePath;

  beforeEach(() => {
    // Create temporary storage for tests
    testStoragePath = `/tmp/devpanel-test-${randomUUID()}`;
    
    // Initialize database
    initMasterDatabase(testStoragePath);
  });

  afterEach(() => {
    // Close database connections
    closeAllDatabases();
  });

  it('should register and retrieve agent nodes', () => {
    const nodeId = randomUUID();
    const nodeName = 'test-node-' + randomUUID();
    
    // Register a new agent node
    registerAgentNode({
      id: nodeId,
      name: nodeName,
      public_key: 'test-public-key'
    });

    // Retrieve the agent node
    const node = getAgentNode(nodeId);
    
    expect(node).toBeDefined();
    expect(node.id).toBe(nodeId);
    expect(node.name).toBe(nodeName);
    expect(node.public_key).toBe('test-public-key');
    expect(node.revoked_at).toBeNull();
    expect(node.last_seen_at).toBeNull();
  });

  it('should authenticate nodes by token', async () => {
    const nodeId = randomUUID();
    const nodeName = 'test-node-' + randomUUID();
    
    // Register a new agent node
    registerAgentNode({
      id: nodeId,
      name: nodeName,
      public_key: 'test-public-key'
    });

    // Authenticate using the node ID as token
    const node = getAgentNodeByToken(nodeId);
    
    expect(node).toBeDefined();
    expect(node.id).toBe(nodeId);
    expect(node.name).toBe(nodeName);
  });

  it('should update last seen timestamp', () => {
    const nodeId = randomUUID();
    const nodeName = 'test-node-' + randomUUID();
    
    // Register a new agent node
    registerAgentNode({
      id: nodeId,
      name: nodeName,
      public_key: 'test-public-key'
    });

    // Update last seen timestamp
    updateAgentNodeLastSeen(nodeId);
    
    // Retrieve the agent node and check last seen
    const node = getAgentNode(nodeId);
    expect(node.last_seen_at).toBeDefined();
  });

  it('should revoke agent nodes', () => {
    const nodeId = randomUUID();
    const nodeName = 'test-node-' + randomUUID();
    
    // Register a new agent node
    registerAgentNode({
      id: nodeId,
      name: nodeName,
      public_key: 'test-public-key'
    });

    // Revoke the agent node
    revokeAgentNode(nodeId, 'test revocation');
    
    // Try to retrieve the revoked node
    const node = getAgentNode(nodeId);
    expect(node).toBeUndefined();
  });

  it('should reject authentication for revoked nodes', async () => {
    const nodeId = randomUUID();
    const nodeName = 'test-node-' + randomUUID();
    
    // Register a new agent node
    registerAgentNode({
      id: nodeId,
      name: nodeName,
      public_key: 'test-public-key'
    });

    // Revoke the agent node
    revokeAgentNode(nodeId, 'test revocation');
    
    // Try to authenticate using the revoked node's token
    const node = getAgentNodeByToken(nodeId);
    expect(node).toBeUndefined();
  });
});