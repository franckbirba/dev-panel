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
  beforeEach(() => {
    initMasterDatabase(`/tmp/devpanel-test-${randomUUID()}`);
  });

  afterEach(() => {
    closeAllDatabases();
  });

  it('stores only the token hash and returns the raw token once', () => {
    const registration = registerAgentNode({ name: `node-${randomUUID()}` });

    expect(registration.token).toHaveLength(64);
    const node = getAgentNode(registration.node_id);
    expect(node.public_key).toHaveLength(64);
    expect(node.public_key).not.toBe(registration.token);
  });

  it('authenticates only the issued token', () => {
    const { node_id: nodeId, token } = registerAgentNode({ name: `node-${randomUUID()}` });

    expect(getAgentNodeByToken(token)?.id).toBe(nodeId);
    expect(getAgentNodeByToken(nodeId)).toBeUndefined();
    expect(getAgentNodeByToken('invalid-token')).toBeUndefined();
  });

  it('updates last seen timestamp', () => {
    const { node_id: nodeId } = registerAgentNode({ name: `node-${randomUUID()}` });

    updateAgentNodeLastSeen(nodeId);

    expect(getAgentNode(nodeId).last_seen_at).toBeDefined();
  });

  it('rejects revoked nodes and their tokens', () => {
    const { node_id: nodeId, token } = registerAgentNode({ name: `node-${randomUUID()}` });

    revokeAgentNode(nodeId, 'test revocation');

    expect(getAgentNode(nodeId)).toBeUndefined();
    expect(getAgentNodeByToken(token)).toBeUndefined();
  });
});
