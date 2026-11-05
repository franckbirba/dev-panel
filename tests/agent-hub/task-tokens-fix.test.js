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

function issueToken() {
  const { node_id: nodeId } = registerAgentNode({ name: `node-${randomUUID()}` });
  const tokenId = randomUUID();
  const { token } = createTaskToken({
    id: tokenId,
    node_id: nodeId,
    task_id: randomUUID(),
    repository: 'test-repo',
    branch: 'main',
    expires_at: new Date(Date.now() + 3600000)
  });
  return { tokenId, token };
}

describe('Task Tokens Fixes', () => {
  beforeEach(() => {
    initMasterDatabase(`/tmp/devpanel-test-${randomUUID()}`);
  });

  afterEach(() => {
    closeAllDatabases();
  });

  it('retrieves completed tokens for audit purposes', () => {
    const { tokenId, token } = issueToken();
    claimTaskToken(token);
    completeTaskToken(token);

    const record = getTaskToken(token);
    expect(record.id).toBe(tokenId);
    expect(record.completed_at).toBeDefined();
  });

  it('rejects completed tokens on a new claim', () => {
    const { token } = issueToken();
    claimTaskToken(token);
    completeTaskToken(token);

    expect(claimTaskToken(token)).toBe(false);
  });
});
