import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { 
  initMasterDatabase, 
  closeAllDatabases,
  registerAgentNode,
  createTaskToken,
  getTaskToken,
  claimTaskToken,
  heartbeatTaskToken,
  completeTaskToken,
  revokeTaskToken
} from '../../src/server/db.js';
import { randomUUID } from 'crypto';

describe('Task Tokens', () => {
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

  it('should create and retrieve task tokens with proper attributes', () => {
    // Register a test node
    const nodeId = randomUUID();
    registerAgentNode({
      id: nodeId,
      name: 'test-node',
      public_key: 'test-public-key'
    });

    // Create a task token
    const tokenId = randomUUID();
    const taskId = randomUUID();
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour from now
    
    createTaskToken({
      id: tokenId,
      node_id: nodeId,
      task_id: taskId,
      repository: 'test-repo',
      branch: 'main',
      expires_at: expiresAt
    });

    // Retrieve the token
    const token = getTaskToken(tokenId);
    
    expect(token).toBeDefined();
    expect(token.id).toBe(tokenId);
    expect(token.node_id).toBe(nodeId);
    expect(token.task_id).toBe(taskId);
    expect(token.repository).toBe('test-repo');
    expect(token.branch).toBe('main');
    expect(token.expires_at).toBe(expiresAt.toISOString());
    expect(token.claimed_at).toBeNull();
    expect(token.heartbeat_at).toBeNull();
    expect(token.completed_at).toBeNull();
    expect(token.revoked_at).toBeNull();
  });

  it('should allow claiming unclaimed tokens', () => {
    // Register a test node
    const nodeId = randomUUID();
    registerAgentNode({
      id: nodeId,
      name: 'test-node',
      public_key: 'test-public-key'
    });

    // Create a task token
    const tokenId = randomUUID();
    const taskId = randomUUID();
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour from now
    
    createTaskToken({
      id: tokenId,
      node_id: nodeId,
      task_id: taskId,
      repository: 'test-repo',
      branch: 'main',
      expires_at: expiresAt
    });

    // Claim the token
    const claimed = claimTaskToken(tokenId);
    
    expect(claimed).toBe(true);
    
    // Verify the token is now marked as claimed
    const token = getTaskToken(tokenId);
    expect(token.claimed_at).toBeDefined();
  });

  it('should reject claiming already claimed tokens', () => {
    // Register a test node
    const nodeId = randomUUID();
    registerAgentNode({
      id: nodeId,
      name: 'test-node',
      public_key: 'test-public-key'
    });

    // Create a task token
    const tokenId = randomUUID();
    const taskId = randomUUID();
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour from now
    
    createTaskToken({
      id: tokenId,
      node_id: nodeId,
      task_id: taskId,
      repository: 'test-repo',
      branch: 'main',
      expires_at: expiresAt
    });

    // Claim the token
    const firstClaim = claimTaskToken(tokenId);
    expect(firstClaim).toBe(true);
    
    // Try to claim again
    const secondClaim = claimTaskToken(tokenId);
    expect(secondClaim).toBe(false);
  });

  it('should handle heartbeat updates', () => {
    // Register a test node
    const nodeId = randomUUID();
    registerAgentNode({
      id: nodeId,
      name: 'test-node',
      public_key: 'test-public-key'
    });

    // Create and claim a task token
    const tokenId = randomUUID();
    const taskId = randomUUID();
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour from now
    
    createTaskToken({
      id: tokenId,
      node_id: nodeId,
      task_id: taskId,
      repository: 'test-repo',
      branch: 'main',
      expires_at: expiresAt
    });

    claimTaskToken(tokenId);

    // Send heartbeat
    const updated = heartbeatTaskToken(tokenId);
    
    expect(updated).toBe(true);
    
    // Verify the token has a heartbeat timestamp
    const token = getTaskToken(tokenId);
    expect(token.heartbeat_at).toBeDefined();
  });

  it('should handle task completion', () => {
    // Register a test node
    const nodeId = randomUUID();
    registerAgentNode({
      id: nodeId,
      name: 'test-node',
      public_key: 'test-public-key'
    });

    // Create and claim a task token
    const tokenId = randomUUID();
    const taskId = randomUUID();
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour from now
    
    createTaskToken({
      id: tokenId,
      node_id: nodeId,
      task_id: taskId,
      repository: 'test-repo',
      branch: 'main',
      expires_at: expiresAt
    });

    claimTaskToken(tokenId);

    // Complete the task
    const completed = completeTaskToken(tokenId);
    
    expect(completed).toBe(true);
    
    // Verify the token is marked as completed
    const token = getTaskToken(tokenId);
    expect(token).toBeDefined();
    expect(token.completed_at).toBeDefined();
  });

  it('should handle token revocation', () => {
    // Register a test node
    const nodeId = randomUUID();
    registerAgentNode({
      id: nodeId,
      name: 'test-node',
      public_key: 'test-public-key'
    });

    // Create a task token
    const tokenId = randomUUID();
    const taskId = randomUUID();
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour from now
    
    createTaskToken({
      id: tokenId,
      node_id: nodeId,
      task_id: taskId,
      repository: 'test-repo',
      branch: 'main',
      expires_at: expiresAt
    });

    // Revoke the token
    revokeTaskToken(tokenId, 'test revocation');
    
    // Verify the token is marked as revoked
    const token = getTaskToken(tokenId);
    expect(token).toBeUndefined(); // Should not be retrievable
    
    // Direct database check should show revoked status
    // Note: This would require a different query to see revoked tokens
  });

  it('should reject expired tokens', () => {
    // Register a test node
    const nodeId = randomUUID();
    registerAgentNode({
      id: nodeId,
      name: 'test-node',
      public_key: 'test-public-key'
    });

    // Create an expired task token
    const tokenId = randomUUID();
    const taskId = randomUUID();
    const expiresAt = new Date(Date.now() - 3600000); // 1 hour ago
    
    createTaskToken({
      id: tokenId,
      node_id: nodeId,
      task_id: taskId,
      repository: 'test-repo',
      branch: 'main',
      expires_at: expiresAt
    });

    // Try to claim the expired token
    const claimed = claimTaskToken(tokenId);
    expect(claimed).toBe(false);
    
    // Try to get the expired token
    const token = getTaskToken(tokenId);
    expect(token).toBeUndefined();
  });
});