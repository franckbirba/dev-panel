// tests/worker/pr-scanner.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listProjectsMock = vi.fn();
const enqueueWorkflowStartMock = vi.fn();
const hasActiveInstanceMock = vi.fn();
const octokitListMock = vi.fn();

vi.mock('../../src/server/db.js', () => ({
  listProjects: listProjectsMock
}));
vi.mock('../../src/worker/dispatch.js', () => ({
  enqueueWorkflowStart: enqueueWorkflowStartMock
}));
vi.mock('../../src/server/webhooks-github.js', async () => {
  const actual = await vi.importActual('../../src/server/webhooks-github.js');
  return { ...actual, hasActiveInstance: hasActiveInstanceMock };
});
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    pulls: { list: octokitListMock }
  }))
}));

import { handlePrScanner } from '../../src/worker/handlers/pr-scanner.js';

describe('handlePrScanner', () => {
  beforeEach(() => {
    listProjectsMock.mockReset();
    enqueueWorkflowStartMock.mockReset();
    hasActiveInstanceMock.mockReset();
    octokitListMock.mockReset();
  });

  it('returns zeroed summary when no projects are registered', async () => {
    listProjectsMock.mockReturnValue([]);
    const result = await handlePrScanner({});
    expect(result).toEqual({
      projects_scanned: 0,
      prs_seen: 0,
      dispatched: 0,
      skipped_active: 0,
      errors: []
    });
    expect(octokitListMock).not.toHaveBeenCalled();
  });
});
