// tests/worker/pr-scanner.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  enqueueWorkflowStartMock: vi.fn(),
  hasActiveInstanceMock: vi.fn(),
  octokitListMock: vi.fn()
}));

vi.mock('../../src/worker/dispatch.js', () => ({
  enqueueWorkflowStart: mocks.enqueueWorkflowStartMock
}));
vi.mock('../../src/server/webhooks-github.js', async () => {
  const actual = await vi.importActual('../../src/server/webhooks-github.js');
  return { ...actual, hasActiveInstance: mocks.hasActiveInstanceMock };
});
vi.mock('octokit', () => ({
  Octokit: vi.fn(function () {
    return {
      pulls: { list: mocks.octokitListMock },
      paginate: async (endpoint, params) => {
        const { data } = await endpoint(params);
        return data;
      }
    };
  })
}));

import { handlePrScanner } from '../../src/worker/handlers/pr-scanner.js';

// Helper: mock the /api/projects/summary HTTP response.
function mockProjects(projects) {
  mocks.fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ projects })
  });
}

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_ADMIN_KEY = process.env.ADMIN_API_KEY;

describe('handlePrScanner', () => {
  beforeEach(() => {
    mocks.fetchMock.mockReset();
    mocks.enqueueWorkflowStartMock.mockReset();
    mocks.hasActiveInstanceMock.mockReset();
    mocks.octokitListMock.mockReset();
    global.fetch = mocks.fetchMock;
    process.env.ADMIN_API_KEY = 'test-admin-key';
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_ADMIN_KEY === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = ORIGINAL_ADMIN_KEY;
  });

  it('returns zeroed summary when no projects are registered', async () => {
    mockProjects([]);
    const result = await handlePrScanner({});
    expect(result).toEqual({
      projects_scanned: 0,
      prs_seen: 0,
      dispatched: 0,
      skipped_active: 0,
      errors: []
    });
    expect(mocks.octokitListMock).not.toHaveBeenCalled();
  });

  it('dispatches merge-coordinator for one open PR on one project', async () => {
    mockProjects([
      { id: 'p1', name: 'edms', github_owner: 'EpitechAfrik', github_repo: 'EDMS' }
    ]);
    mocks.octokitListMock.mockResolvedValue({
      data: [{
        number: 6,
        title: 'feat: add upload retry',
        body: 'fixes EDMS-17',
        head: { ref: 'feat/upload-retry', sha: 'abc123' }
      }]
    });
    mocks.hasActiveInstanceMock.mockResolvedValue(false);
    mocks.enqueueWorkflowStartMock.mockResolvedValue({ ok: true, instance_id: 'i1', job_id: 'j1' });

    const result = await handlePrScanner({});

    expect(result.projects_scanned).toBe(1);
    expect(result.prs_seen).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(result.skipped_active).toBe(0);
    expect(mocks.enqueueWorkflowStartMock).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueWorkflowStartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'merge-coordinator',
        plane: { work_item_id: 'github:EpitechAfrik/EDMS#6' },
        work_item: expect.objectContaining({ title: 'feat: add upload retry' }),
        context: expect.objectContaining({
          github: expect.objectContaining({
            repo: 'EpitechAfrik/EDMS',
            pr_number: 6,
            head_sha: 'abc123',
            branch: 'feat/upload-retry'
          })
        })
      })
    );
  });

  it('skips PRs that already have an active merge-coordinator', async () => {
    mockProjects([
      { id: 'p1', name: 'edms', github_owner: 'EpitechAfrik', github_repo: 'EDMS' }
    ]);
    mocks.octokitListMock.mockResolvedValue({
      data: [
        { number: 6, title: 'PR 6', body: '', head: { ref: 'b1', sha: 's1' } },
        { number: 7, title: 'PR 7', body: '', head: { ref: 'b2', sha: 's2' } }
      ]
    });
    mocks.hasActiveInstanceMock.mockImplementation(async (_repo, n) => n === 6);
    mocks.enqueueWorkflowStartMock.mockResolvedValue({ ok: true, instance_id: 'i', job_id: 'j' });

    const result = await handlePrScanner({});

    expect(result.prs_seen).toBe(2);
    expect(result.dispatched).toBe(1);
    expect(result.skipped_active).toBe(1);
    expect(mocks.enqueueWorkflowStartMock).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueWorkflowStartMock.mock.calls[0][0].plane.work_item_id)
      .toBe('github:EpitechAfrik/EDMS#7');
  });

  it('continues to next repo when GitHub returns an error', async () => {
    mockProjects([
      { id: 'p1', name: 'edms', github_owner: 'EpitechAfrik', github_repo: 'EDMS' },
      { id: 'p2', name: 'zeno', github_owner: 'franckbirba', github_repo: 'zeno' }
    ]);
    mocks.octokitListMock.mockImplementation(async ({ owner }) => {
      if (owner === 'EpitechAfrik') {
        const err = new Error('Not Found');
        err.status = 404;
        throw err;
      }
      return { data: [{ number: 1, title: 'z1', body: '', head: { ref: 'b', sha: 's' } }] };
    });
    mocks.hasActiveInstanceMock.mockResolvedValue(false);
    mocks.enqueueWorkflowStartMock.mockResolvedValue({ ok: true, instance_id: 'i', job_id: 'j' });

    const result = await handlePrScanner({});

    expect(result.projects_scanned).toBe(2);
    expect(result.prs_seen).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ repo: 'EpitechAfrik/EDMS' });
  });

  it('ignores projects with missing github_owner or github_repo', async () => {
    mockProjects([
      { id: 'p1', name: 'no-gh', github_owner: null, github_repo: null },
      { id: 'p2', name: 'half',  github_owner: 'foo', github_repo: null },
      { id: 'p3', name: 'ok',    github_owner: 'foo', github_repo: 'bar' }
    ]);
    mocks.octokitListMock.mockResolvedValue({ data: [] });

    const result = await handlePrScanner({});

    expect(result.projects_scanned).toBe(1);
    expect(mocks.octokitListMock).toHaveBeenCalledTimes(1);
    expect(mocks.octokitListMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'foo', repo: 'bar', state: 'open' })
    );
  });

  it('records an error and returns empty when fetching projects fails', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const result = await handlePrScanner({});
    expect(result.projects_scanned).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ scope: 'projects' });
    expect(mocks.octokitListMock).not.toHaveBeenCalled();
  });
});
