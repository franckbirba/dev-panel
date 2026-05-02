// tests/worker/pr-scanner.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  listProjectsMock: vi.fn(),
  enqueueWorkflowStartMock: vi.fn(),
  hasActiveInstanceMock: vi.fn(),
  octokitListMock: vi.fn()
}));

vi.mock('../../src/server/db.js', () => ({
  listProjects: mocks.listProjectsMock
}));
vi.mock('../../src/worker/dispatch.js', () => ({
  enqueueWorkflowStart: mocks.enqueueWorkflowStartMock
}));
vi.mock('../../src/server/webhooks-github.js', async () => {
  const actual = await vi.importActual('../../src/server/webhooks-github.js');
  return { ...actual, hasActiveInstance: mocks.hasActiveInstanceMock };
});
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    pulls: { list: mocks.octokitListMock }
  }))
}));

import { handlePrScanner } from '../../src/worker/handlers/pr-scanner.js';

describe('handlePrScanner', () => {
  beforeEach(() => {
    mocks.listProjectsMock.mockReset();
    mocks.enqueueWorkflowStartMock.mockReset();
    mocks.hasActiveInstanceMock.mockReset();
    mocks.octokitListMock.mockReset();
  });

  it('returns zeroed summary when no projects are registered', async () => {
    mocks.listProjectsMock.mockReturnValue([]);
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
});
