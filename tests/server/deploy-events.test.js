import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject } from '../../src/server/db.js';
import { recordDeployEvent, listRecentDeploys } from '../../src/server/deploy-events.js';

describe('deploy events', () => {
  let project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-de-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
  });

  it('records a deploy event', () => {
    const id = recordDeployEvent({
      project_id: project.id, status: 'succeeded',
      sha: 'abc1234', ref: 'main', log_url: 'https://ci/run/1'
    });
    expect(id).toBeGreaterThan(0);
    const rows = listRecentDeploys(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'succeeded', sha: 'abc1234', ref: 'main' });
  });

  it('rejects invalid status', () => {
    expect(() => recordDeployEvent({ project_id: project.id, status: 'maybe' })).toThrow(/invalid status/);
  });

  it('listRecentDeploys returns most recent first, capped', () => {
    for (let i = 0; i < 30; i++) {
      recordDeployEvent({ project_id: project.id, status: 'succeeded', sha: `s${i}` });
    }
    const rows = listRecentDeploys(project.id, 10);
    expect(rows).toHaveLength(10);
    expect(rows[0].sha).toBe('s29');
  });
});
