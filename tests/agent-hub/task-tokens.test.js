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

function issueToken({ expiresAt = new Date(Date.now() + 3600000) } = {}) {
  const { node_id: nodeId } = registerAgentNode({ name: `node-${randomUUID()}` });
  const tokenId = randomUUID();
  const taskId = randomUUID();
  const { token } = createTaskToken({
    id: tokenId,
    node_id: nodeId,
    task_id: taskId,
    repository: 'test-repo',
    branch: 'main',
    expires_at: expiresAt
  });
  return { nodeId, tokenId, taskId, token, expiresAt };
}

describe('Task Tokens', () => {
  beforeEach(() => {
    initMasterDatabase(`/tmp/devpanel-test-${randomUUID()}`);
  });

  afterEach(() => {
    closeAllDatabases();
  });

  it('stores a hash and retrieves token attributes', () => {
    const { nodeId, tokenId, taskId, token, expiresAt } = issueToken();

    const record = getTaskToken(token);

    expect(record.id).toBe(tokenId);
    expect(record.token_hash).toHaveLength(64);
    expect(record.token_hash).not.toBe(token);
    expect(record.node_id).toBe(nodeId);
    expect(record.task_id).toBe(taskId);
    expect(record.repository).toBe('test-repo');
    expect(record.branch).toBe('main');
    expect(record.expires_at).toBe(expiresAt.toISOString());
    expect(record.claimed_at).toBeNull();
    expect(record.completed_at).toBeNull();
  });

  it('allows only one claim', () => {
    const { token } = issueToken();

    expect(claimTaskToken(token)).toBe(true);
    expect(claimTaskToken(token)).toBe(false);
    expect(getTaskToken(token).claimed_at).toBeDefined();
  });

  it('updates heartbeat and extends a short lease', () => {
    const { token, expiresAt } = issueToken({ expiresAt: new Date(Date.now() + 300000) });
    claimTaskToken(token);

    expect(heartbeatTaskToken(token)).toBe(true);

    const record = getTaskToken(token);
    expect(record.heartbeat_at).toBeDefined();
    expect(new Date(record.expires_at).getTime()).toBeGreaterThan(expiresAt.getTime());
  });

  it('completes idempotently and keeps the audit record', () => {
    const { token } = issueToken();
    claimTaskToken(token);

    expect(completeTaskToken(token)).toBe(true);
    expect(completeTaskToken(token)).toBe(true);
    expect(getTaskToken(token).completed_at).toBeDefined();
    expect(claimTaskToken(token)).toBe(false);
  });

  it('rejects revoked tokens', () => {
    const { token } = issueToken();

    revokeTaskToken(token, 'test revocation');

    expect(getTaskToken(token)).toBeUndefined();
    expect(claimTaskToken(token)).toBe(false);
  });

  it('rejects expired tokens', () => {
    const { token } = issueToken({ expiresAt: new Date(Date.now() - 3600000) });

    expect(getTaskToken(token)).toBeUndefined();
    expect(claimTaskToken(token)).toBe(false);
  });
});
