import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, getMasterDatabase, createProject } from '../../src/server/db.js';
import { upsertSubject, setPriority, getSubject } from '../../src/server/subjects.js';

describe('subjects', () => {
  let project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-subj-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'me', github_repo: 'demo' });
  });

  it('upserts a new subject with null priority', () => {
    upsertSubject({ subject_type: 'work_item', subject_id: 'WI-1', project_id: project.id, title: 'Fix login' });
    const s = getSubject('work_item', 'WI-1');
    expect(s).toMatchObject({ subject_type: 'work_item', subject_id: 'WI-1', title: 'Fix login', priority: null });
  });

  it('upsert is idempotent — second call updates title without changing priority', () => {
    upsertSubject({ subject_type: 'work_item', subject_id: 'WI-1', project_id: project.id, title: 'Old' });
    setPriority('work_item', 'WI-1', 'now');
    upsertSubject({ subject_type: 'work_item', subject_id: 'WI-1', project_id: project.id, title: 'New' });
    const s = getSubject('work_item', 'WI-1');
    expect(s.title).toBe('New');
    expect(s.priority).toBe('now');
  });

  it('setPriority writes priority_set_at', () => {
    upsertSubject({ subject_type: 'capture', subject_id: 'cap-1', project_id: project.id, title: 't' });
    setPriority('capture', 'cap-1', 'today');
    const s = getSubject('capture', 'cap-1');
    expect(s.priority).toBe('today');
    expect(s.priority_set_at).toBeTruthy();
  });

  it('setPriority(null) clears the lane', () => {
    upsertSubject({ subject_type: 'capture', subject_id: 'cap-2', project_id: project.id, title: 't' });
    setPriority('capture', 'cap-2', 'now');
    setPriority('capture', 'cap-2', null);
    const s = getSubject('capture', 'cap-2');
    expect(s.priority).toBe(null);
  });

  it('rejects invalid priority value', () => {
    upsertSubject({ subject_type: 'capture', subject_id: 'cap-3', project_id: project.id, title: 't' });
    expect(() => setPriority('capture', 'cap-3', 'urgent')).toThrow(/invalid priority/);
  });

  it('setPriority on unknown subject throws (must upsert first)', () => {
    expect(() => setPriority('work_item', 'NOPE', 'now')).toThrow(/subject not found/);
  });
});
