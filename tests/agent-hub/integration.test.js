import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'http';
import { 
  initMasterDatabase, 
  closeAllDatabases,
  registerAgentNode,
  createTaskToken
} from '../../src/server/db.js';
import { initAgentHub, closeAgentHub } from '../../src/server/agent-hub.js';
import { io as ioClient } from 'socket.io-client';
import { randomUUID } from 'crypto';

describe('Agent Hub Integration', () => {
  let server;
  let httpServer;
  let testStoragePath;

  beforeEach(() => {
    // Create temporary storage for tests
    testStoragePath = `/tmp/devpanel-test-${randomUUID()}`;
    
    // Initialize database
    initMasterDatabase(testStoragePath);
  });

  afterEach(async () => {
    await closeAgentHub();
    closeAllDatabases();
    
    if (httpServer) {
      await new Promise(resolve => httpServer.close(resolve));
      httpServer = null;
    }
  });

  it('should allow external node authentication with individual token', async () => {
    // Set up server
    httpServer = createServer();
    const io = initAgentHub(httpServer, { token: 'legacy-shared-token' });
    
    // Start server
    await new Promise(resolve => {
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    
    const port = httpServer.address().port;
    const url = `http://127.0.0.1:${port}`;
    
    // Register a test node
    const nodeId = randomUUID();
    const { token: nodeToken } = registerAgentNode({
      id: nodeId,
      name: 'test-node',
      public_key: 'test-public-key'
    });
    
    // Connect with node token
    const socket = ioClient(url, {
      path: '/agents/socket.io',
      transports: ['websocket'],
      auth: { token: nodeToken }
    });
    
    // Wait for connection
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
      
      // Timeout
      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });
    
    // Verify socket has node_id attached
    expect(socket.connected).toBe(true);
    
    socket.disconnect();
  });

  it('should reject invalid node tokens', async () => {
    // Set up server
    httpServer = createServer();
    const io = initAgentHub(httpServer, { token: 'legacy-shared-token' });
    
    // Start server
    await new Promise(resolve => {
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    
    const port = httpServer.address().port;
    const url = `http://127.0.0.1:${port}`;
    
    // Connect with invalid token
    const socket = ioClient(url, {
      path: '/agents/socket.io',
      transports: ['websocket'],
      auth: { token: 'invalid-token' }
    });
    
    // Wait for connection error
    await new Promise((resolve, reject) => {
      socket.on('connect', () => reject(new Error('Should not connect with invalid token')));
      socket.on('connect_error', resolve);
      
      // Timeout
      setTimeout(() => reject(new Error('Expected connection error')), 5000);
    });
    
    socket.disconnect();
  });

  it('should allow task claim with valid token assignment', async () => {
    // Set up server
    httpServer = createServer();
    const io = initAgentHub(httpServer, { token: 'legacy-shared-token' });
    
    // Start server
    await new Promise(resolve => {
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    
    const port = httpServer.address().port;
    const url = `http://127.0.0.1:${port}`;
    
    // Register a test node
    const nodeId = randomUUID();
    const { token: nodeToken } = registerAgentNode({
      id: nodeId,
      name: 'test-node',
      public_key: 'test-public-key'
    });
    
    // Create a task token assigned to the node
    const tokenId = randomUUID();
    const taskId = randomUUID();
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour from now
    
    const { token: issuedToken } = createTaskToken({
      id: tokenId,
      node_id: nodeId,
      task_id: taskId,
      repository: 'test-repo',
      branch: 'main',
      expires_at: expiresAt
    });
    
    // Connect with node token
    const socket = ioClient(url, {
      path: '/agents/socket.io',
      transports: ['websocket'],
      auth: { token: nodeToken }
    });
    
    // Wait for connection
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
      
      // Timeout
      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });
    
    // Try to claim task
    const result = await new Promise((resolve, reject) => {
      socket.emit('agent:claim', { token_id: issuedToken }, resolve);
      
      // Timeout
      setTimeout(() => reject(new Error('Claim timeout')), 5000);
    });
    
    // Verify successful claim
    expect(result.success).toBe(true);
    expect(result.task.id).toBe(taskId);
    
    socket.disconnect();
  });
});