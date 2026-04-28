import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const broadcastMock = vi.fn();
const dispatchMock = vi.fn();

// Mock pg pool so hasActiveInstance doesn't hit a real DB
vi.mock('../../src/server/pg.js', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [] })
  }
}));

vi.mock('../../src/server/release-notes.js', () => ({
  broadcastRelease: (...a) => broadcastMock(...a)
}));

import { mountGitHubWebhook, __setDispatchForTests } from '../../src/server/webhooks-github.js';

function makeApp() {
  const app = express();
  mountGitHubWebhook(app);
  return app;
}

function payload(action, merged) {
  return {
    action,
    pull_request: {
      number: 42,
      title: 'Hello',
      merged,
      head: { sha: 'sha', ref: 'feat/wi-7096cee4-x' },
      body: ''
    },
    repository: { full_name: 'owner/repo' }
  };
}

describe('webhook closed+merged', () => {
  beforeEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    broadcastMock.mockReset();
    dispatchMock.mockReset();
    __setDispatchForTests(dispatchMock);
  });

  it('calls broadcastRelease on closed+merged=true', async () => {
    broadcastMock.mockResolvedValueOnce({ broadcast: true });
    const r = await request(makeApp())
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .send(payload('closed', true));
    expect(r.status).toBe(202);
    expect(broadcastMock).toHaveBeenCalledOnce();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('returns 204 when broadcast is a replay', async () => {
    broadcastMock.mockResolvedValueOnce({ broadcast: false, reason: 'replay' });
    const r = await request(makeApp())
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .send(payload('closed', true));
    expect(r.status).toBe(204);
  });

  it('does nothing on closed+merged=false', async () => {
    const r = await request(makeApp())
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .send(payload('closed', false));
    expect(r.status).toBe(204);
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('still dispatches merge-coordinator on opened (regression)', async () => {
    dispatchMock.mockResolvedValueOnce({ ok: true, instance_id: 'i1', job_id: 'j1' });
    const r = await request(makeApp())
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .send(payload('opened', false));
    expect(r.status).toBe(201);
    expect(dispatchMock).toHaveBeenCalledOnce();
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
