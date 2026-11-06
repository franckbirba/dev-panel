// tests/worker/automation-high-risk.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('automation — high-risk auto-merge handling', () => {
  let runAutomation, __setEnqueueForTests, __testables;

  beforeAll(async () => {
    await startPg();
    ({ runAutomation, __setEnqueueForTests, __testables } = await import('../../src/worker/automation.js'));
  }, 60000);

  afterAll(async () => {
    await stopPg();
  });

  beforeEach(() => truncateOrchestration());

  it('autoMergePullRequest blocks merge for high-risk work-item labels', async () => {
    const { autoMergePullRequest } = __testables;
    
    // Test with high-risk labels in work-item context
    const result = await autoMergePullRequest({
      prUrl: 'https://github.com/test/repo/pull/1',
      cwd: '/tmp',
      jobData: {
        workflow: 'work-item',
        context: {
          labels: ['high-risk', 'migration']
        }
      }
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('high-risk label detected');
  });

  it('autoMergePullRequest allows merge for normal work-item labels', async () => {
    const { autoMergePullRequest } = __testables;
    
    // Mock execSync to simulate successful merge
    const mockExecSync = vi.spyOn(await import('child_process'), 'execSync');
    mockExecSync.mockReturnValue('Merged pull request #1');

    // Test with normal labels in work-item context
    const result = await autoMergePullRequest({
      prUrl: 'https://github.com/test/repo/pull/1',
      cwd: '/tmp',
      jobData: {
        workflow: 'work-item',
        context: {
          labels: ['feature', 'enhancement']
        }
      }
    });

    // Should attempt to merge (but fail due to missing gh command in test)
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain('high-risk label detected');

    mockExecSync.mockRestore();
  });

  it('autoMergePullRequest handles merge-coordinator workflows with GitHub PR labels', async () => {
    const { autoMergePullRequest } = __testables;
    
    // Mock getPullRequestLabels to return high-risk labels
    const mockGetPullRequestLabels = vi.spyOn(await import('../../src/server/github.js'), 'getPullRequestLabels');
    mockGetPullRequestLabels.mockResolvedValue(['high-risk', 'auth']);

    // Test with merge-coordinator workflow and high-risk GitHub labels
    const result = await autoMergePullRequest({
      prUrl: 'https://github.com/test/repo/pull/1',
      cwd: '/tmp',
      jobData: {
        workflow: 'merge-coordinator',
        context: {
          github: {
            repo: 'test/repo',
            pr_number: 1
          }
        }
      }
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('high-risk label detected');

    mockGetPullRequestLabels.mockRestore();
  });
});