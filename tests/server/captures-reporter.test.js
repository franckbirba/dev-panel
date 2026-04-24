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

describe('captures reporter identity', () => {
  let tmp, project;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-reporter-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo' });
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('stores reporter id/name/email in columns when createCapture receives reporter', () => {
    const cap = createCapture({
      project_id: project.id,
      content: 'bug on page 7',
      kind: 'bug',
      reporter: { id: 'u_42', name: 'Alice', email: 'alice@zeno.com' }
    });
    expect(cap.reporter_id).toBe('u_42');
    expect(cap.reporter_name).toBe('Alice');
    expect(cap.reporter_email).toBe('alice@zeno.com');
  });

  it('stores non-standard reporter fields in reporter_extra JSON', () => {
    const cap = createCapture({
      project_id: project.id,
      content: 'x',
      reporter: { id: 'u_1', name: 'A', email: 'a@x', role: 'pm', team: 'core' }
    });
    const extras = JSON.parse(cap.reporter_extra);
    expect(extras).toEqual({ role: 'pm', team: 'core' });
  });

  it('leaves reporter columns null when reporter is not passed', () => {
    const cap = createCapture({ project_id: project.id, content: 'x' });
    expect(cap.reporter_id).toBeNull();
    expect(cap.reporter_name).toBeNull();
    expect(cap.reporter_email).toBeNull();
    expect(cap.reporter_extra).toBeNull();
  });

  it('truncates reporter fields to 255 chars', () => {
    const long = 'x'.repeat(300);
    const cap = createCapture({
      project_id: project.id,
      content: 'x',
      reporter: { id: long, name: long, email: long }
    });
    expect(cap.reporter_id.length).toBe(255);
    expect(cap.reporter_name.length).toBe(255);
    expect(cap.reporter_email.length).toBe(255);
  });

  it('getCapture returns a `reporter` object assembled from columns + extras', () => {
    const created = createCapture({
      project_id: project.id,
      content: 'x',
      reporter: { id: 'u_1', name: 'A', email: 'a@x', role: 'pm' }
    });
    const full = getCapture(created.id);
    expect(full.reporter).toEqual({ id: 'u_1', name: 'A', email: 'a@x', role: 'pm' });
  });

  it('getCapture returns reporter=null when no reporter was stored', () => {
    const created = createCapture({ project_id: project.id, content: 'x' });
    const full = getCapture(created.id);
    expect(full.reporter).toBeNull();
  });

  it('listCaptures filters by reporter_id', () => {
    createCapture({ project_id: project.id, content: 'a', reporter: { id: 'u_1', name: 'A' } });
    createCapture({ project_id: project.id, content: 'b', reporter: { id: 'u_2', name: 'B' } });
    createCapture({ project_id: project.id, content: 'c' });
    const filtered = listCaptures({ project_id: project.id, reporter_id: 'u_1' });
    expect(filtered.length).toBe(1);
    expect(filtered[0].content).toBe('a');
  });
});
