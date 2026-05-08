import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const broadcastMock = vi.fn();
const dispatchMock = vi.fn();
const getProjectByGithubRepoMock = vi.fn();

// Mock pg pool so hasActiveInstance doesn't hit a real DB
vi.mock('../../src/server/pg.js', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [] })
  }
}));

vi.mock('../../src/server/release-notes.js', () => ({
  broadcastRelease: (...a) => broadcastMock(...a)
}));

// Mock the projects-table lookup so the webhook can resolve repo →
// plane_project_id without a real master SQLite. The webhook's runtime
// `import { getProjectByGithubRepo } from './db.js'` is rewritten to this
// mock by Vitest's module hoisting.
vi.mock('../../src/server/db.js', () => ({
  getProjectByGithubRepo: (...a) => getProjectByGithubRepoMock(...a)
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
    getProjectByGithubRepoMock.mockReset();
    getProjectByGithubRepoMock.mockReturnValue(null); // no project linked by default
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

  // DEVPA-180: when the PR's repo is registered in the master projects
  // table, the webhook MUST pass plane_project_id into the dispatch so the
  // worker creates the worktree under the right local checkout. Without
  // this, every Zeno/EDMS PR worktree was being made under PROJECT_ROOT
  // (dev-panel) and the builder was pushing commits to the wrong repo.
  it('passes plane_project_id when the repo is linked in the projects table', async () => {
    getProjectByGithubRepoMock.mockReturnValueOnce({
      id: 'p-zeno', name: 'Zeno',
      github_owner: 'owner', github_repo: 'repo',
      plane_project_id: 'plane-zeno-uuid',
      local_path: '/home/deploy/projects/Zeno'
    });
    dispatchMock.mockResolvedValueOnce({ ok: true, instance_id: 'i2', job_id: 'j2' });
    const r = await request(makeApp())
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .send(payload('opened', false));
    expect(r.status).toBe(201);
    expect(getProjectByGithubRepoMock).toHaveBeenCalledWith('owner', 'repo');
    const call = dispatchMock.mock.calls[0][0];
    expect(call.plane.project_id).toBe('plane-zeno-uuid');
    expect(call.plane.work_item_id).toBe('github:owner/repo#42');
  });

  it('omits plane.project_id when the repo is NOT in the projects table', async () => {
    getProjectByGithubRepoMock.mockReturnValueOnce(null);
    dispatchMock.mockResolvedValueOnce({ ok: true, instance_id: 'i3', job_id: 'j3' });
    const r = await request(makeApp())
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .send(payload('opened', false));
    expect(r.status).toBe(201);
    const call = dispatchMock.mock.calls[0][0];
    expect(call.plane.project_id).toBeUndefined();
  });
});
