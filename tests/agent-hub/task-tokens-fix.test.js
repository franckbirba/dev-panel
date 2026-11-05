import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { 
  initMasterDatabase, 
  closeAllDatabases,
  registerAgentNode,
  createTaskToken,
  getTaskToken,
  claimTaskToken,
  completeTaskToken
} from '../../src/server/db.js';
import { randomUUID } from 'crypto';

describe('Task Tokens Fixes', () => {
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

  it('should retrieve completed tokens for audit purposes', () => {
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

    // Claim and complete the token
    claimTaskToken(tokenId);
    completeTaskToken(tokenId);
    
    // Should still be able to retrieve the token for audit purposes
    const token = getTaskToken(tokenId);
    expect(token).toBeDefined();
    expect(token.id).toBe(tokenId);
    expect(token.completed_at).toBeDefined();
  });

  it('should reject claiming expired tokens', () => {
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
  });

  it('should reject claiming already completed tokens', () => {
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

    // Claim and complete the token
    claimTaskToken(tokenId);
    completeTaskToken(tokenId);
    
    // Try to claim again - should fail
    const claimedAgain = claimTaskToken(tokenId);
    expect(claimedAgain).toBe(false);
  });
});