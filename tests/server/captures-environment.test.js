import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject, closeAllDatabases } from '../../src/server/db.js';
import { createCapture, getCapture, listCaptures } from '../../src/server/captures.js';

vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ getJobs: async () => [] }),
  QUEUES: { agent: 'agent' }
}));

describe('captures environment tag', () => {
  let tmp, project;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-capenv-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo' });
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('stores environment string on createCapture', () => {
    const cap = createCapture({
      project_id: project.id,
      content: 'bug on page 7',
      kind: 'bug',
      environment: 'production'
    });
    expect(cap.environment).toBe('production');
  });

  it('leaves environment null when not passed', () => {
    const cap = createCapture({ project_id: project.id, content: 'x' });
    expect(cap.environment).toBeNull();
  });

  it('stores null when environment is explicitly null', () => {
    const cap = createCapture({ project_id: project.id, content: 'x', environment: null });
    expect(cap.environment).toBeNull();
  });

  it('getCapture returns the environment string as-is', () => {
    const created = createCapture({
      project_id: project.id,
      content: 'x',
      environment: 'staging'
    });
    const full = getCapture(created.id);
    expect(full.environment).toBe('staging');
  });

  it('listCaptures filters by environment', () => {
    createCapture({ project_id: project.id, content: 'a', environment: 'production' });
    createCapture({ project_id: project.id, content: 'b', environment: 'staging' });
    createCapture({ project_id: project.id, content: 'c' });
    const prod = listCaptures({ project_id: project.id, environment: 'production' });
    expect(prod.length).toBe(1);
    expect(prod[0].content).toBe('a');
  });

  it('listCaptures without environment filter returns all rows', () => {
    createCapture({ project_id: project.id, content: 'a', environment: 'production' });
    createCapture({ project_id: project.id, content: 'b' });
    const all = listCaptures({ project_id: project.id });
    expect(all.length).toBe(2);
  });
});
