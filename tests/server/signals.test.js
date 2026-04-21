import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject, getMasterDatabase } from '../../src/server/db.js';
import { upsertSubject, setPriority } from '../../src/server/subjects.js';
import { recordDeployEvent } from '../../src/server/deploy-events.js';

// signals module imports BullMQ; mock the queue helper so tests don't need Redis.
vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ getJobs: async () => [] }),
  QUEUES: { agent: 'agent' }
}));

import { buildSignalsFeed } from '../../src/server/signals.js';

describe('signals aggregator', () => {
  let project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-sig-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
  });

  it('returns empty feed when nothing happened', async () => {
    const rows = await buildSignalsFeed({});
    expect(rows).toEqual([]);
  });

  it('includes a failed deploy as needs_attention urgency', async () => {
    recordDeployEvent({ project_id: project.id, status: 'failed', sha: 'abc', failed_reason: 'lint' });
    const rows = await buildSignalsFeed({});
    const deployRow = rows.find(r => r.signal_type === 'deploy_failed');
    expect(deployRow).toBeDefined();
    expect(deployRow.urgency).toBe('needs_attention');
    expect(deployRow.project_id).toBe(project.id);
  });

  it('includes a successful deploy as fyi urgency', async () => {
    recordDeployEvent({ project_id: project.id, status: 'succeeded', sha: 'def' });
    const rows = await buildSignalsFeed({});
    const deployRow = rows.find(r => r.signal_type === 'deploy_succeeded');
    expect(deployRow.urgency).toBe('fyi');
  });

  it('attaches subject priority to a row when subject row exists', async () => {
    recordDeployEvent({ project_id: project.id, status: 'failed', sha: 'abc' });
    upsertSubject({ subject_type: 'deploy', subject_id: 'abc', project_id: project.id, title: 'deploy abc' });
    setPriority('deploy', 'abc', 'now');
    const rows = await buildSignalsFeed({});
    const deployRow = rows.find(r => r.signal_type === 'deploy_failed');
    expect(deployRow.priority).toBe('now');
  });

  it('filters by priority when ?priority=now', async () => {
    recordDeployEvent({ project_id: project.id, status: 'failed', sha: 'abc' });
    recordDeployEvent({ project_id: project.id, status: 'failed', sha: 'def' });
    upsertSubject({ subject_type: 'deploy', subject_id: 'abc', project_id: project.id, title: 't' });
    setPriority('deploy', 'abc', 'now');
    upsertSubject({ subject_type: 'deploy', subject_id: 'def', project_id: project.id, title: 't' });
    setPriority('deploy', 'def', 'later');
    const rows = await buildSignalsFeed({ priority: 'now' });
    expect(rows.map(r => r.subject_id)).toEqual(['abc']);
  });

  it('filters by needs_me_only', async () => {
    recordDeployEvent({ project_id: project.id, status: 'failed', sha: 'abc' });
    recordDeployEvent({ project_id: project.id, status: 'succeeded', sha: 'def' });
    const rows = await buildSignalsFeed({ needs_me_only: true });
    expect(rows.every(r => r.urgency === 'needs_attention')).toBe(true);
  });
});
