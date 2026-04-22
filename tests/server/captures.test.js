import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { initMasterDatabase, createProject, getMasterDatabase } from '../../src/server/db.js';
import { createCapture, getCapture, listCaptures, deleteCapture } from '../../src/server/captures.js';
import { getOrCreateThread, appendMessage } from '../../src/server/threads.js';

describe('captures migration (capture_messages → thread_messages)', () => {
  let tmp;
  let project;

  function bootWithLegacyData() {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-capmig-'));
    // First boot — create schema, insert project + legacy rows.
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });

    // Open the raw db to seed legacy rows before the migration runs.
    const raw = new Database(join(tmp, 'projects.db'));
    raw.exec(`PRAGMA user_version = 0`); // force migration to re-run on next boot
    // Recreate capture_messages in case it was already dropped on first boot.
    raw.exec(`
      CREATE TABLE IF NOT EXISTS capture_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        capture_id TEXT NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        metadata   TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    raw.prepare(`
      INSERT INTO captures (id, project_id, kind, content, status, created_by)
      VALUES ('cap-1', ?, 'idea', 'first thought', 'triaging', 'franck')
    `).run(project.id);
    raw.prepare(`
      INSERT INTO capture_messages (capture_id, role, content, created_at)
      VALUES ('cap-1', 'user',   'first thought', '2026-04-21 10:00:00'),
             ('cap-1', 'shelly', 'got it, bug or feature?', '2026-04-21 10:01:00'),
             ('cap-1', 'user',   'bug', '2026-04-21 10:02:00')
    `).run();
    raw.close();
  }

  beforeEach(() => { bootWithLegacyData(); });

  it('backfills capture_messages into thread_messages and drops the old table', () => {
    // Second boot — migration should run.
    initMasterDatabase(tmp);
    const db = getMasterDatabase();

    const subj = db.prepare(
      `SELECT * FROM subjects WHERE subject_type='capture' AND subject_id='cap-1'`
    ).get();
    expect(subj).toBeTruthy();
    expect(subj.project_id).toBe(project.id);

    const thread = db.prepare(
      `SELECT * FROM threads WHERE subject_type='capture' AND subject_id='cap-1'`
    ).get();
    expect(thread).toBeTruthy();

    const msgs = db.prepare(
      `SELECT role, source, content FROM thread_messages
        WHERE thread_id=? ORDER BY id ASC`
    ).all(thread.thread_id);
    expect(msgs).toHaveLength(3);
    expect(msgs.map(m => m.role)).toEqual(['user', 'shelly', 'user']);
    expect(msgs.every(m => m.source === 'web')).toBe(true);
    expect(msgs[0].content).toBe('first thought');
    expect(msgs[1].content).toBe('got it, bug or feature?');
    expect(msgs[2].content).toBe('bug');

    const captureMessagesExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='capture_messages'`
    ).get();
    expect(captureMessagesExists).toBeUndefined();
  });

  it('is idempotent: re-initialising on an already-migrated db is a no-op', () => {
    initMasterDatabase(tmp); // runs migration
    initMasterDatabase(tmp); // should be a no-op
    const db = getMasterDatabase();
    const msgs = db.prepare(
      `SELECT COUNT(*) AS n FROM thread_messages tm
         JOIN threads t ON t.thread_id=tm.thread_id
        WHERE t.subject_type='capture' AND t.subject_id='cap-1'`
    ).get();
    expect(msgs.n).toBe(3);
  });
});

describe('captures (thread-backed)', () => {
  let project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-cap-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
  });

  it('createCapture seeds subject, thread, and a user message in thread_messages', () => {
    const cap = createCapture({ project_id: project.id, content: 'found a bug' });
    expect(cap.id).toBeTruthy();
    expect(cap.status).toBe('new');
    expect(cap.messages).toHaveLength(1);
    expect(cap.messages[0]).toMatchObject({ role: 'user', content: 'found a bug' });

    const db = getMasterDatabase();
    const subj = db.prepare(
      `SELECT * FROM subjects WHERE subject_type='capture' AND subject_id=?`
    ).get(cap.id);
    expect(subj).toBeTruthy();
    const thread = db.prepare(
      `SELECT * FROM threads WHERE subject_type='capture' AND subject_id=?`
    ).get(cap.id);
    expect(thread).toBeTruthy();
    const msgs = db.prepare(
      `SELECT role, source, content FROM thread_messages WHERE thread_id=?`
    ).all(thread.thread_id);
    expect(msgs).toEqual([{ role: 'user', source: 'web', content: 'found a bug' }]);
  });

  it('getCapture reads messages from thread_messages ordered by time', () => {
    const cap = createCapture({ project_id: project.id, content: 'hi' });
    const t = getOrCreateThread('capture', cap.id);
    appendMessage({ thread_id: t.thread_id, role: 'shelly', source: 'telegram', content: 'yo' });

    const reloaded = getCapture(cap.id);
    expect(reloaded.messages).toHaveLength(2);
    expect(reloaded.messages[0]).toMatchObject({ role: 'user', content: 'hi' });
    expect(reloaded.messages[1]).toMatchObject({ role: 'shelly', content: 'yo' });
  });

  it('listCaptures returns message_count, last_message, last_role from thread_messages', () => {
    const cap = createCapture({ project_id: project.id, content: 'foo' });
    const t = getOrCreateThread('capture', cap.id);
    appendMessage({ thread_id: t.thread_id, role: 'shelly', source: 'telegram', content: 'bar' });

    const list = listCaptures({ project_id: project.id });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: cap.id,
      message_count: 2,
      last_message: 'bar',
      last_role: 'shelly'
    });
  });

  it('deleteCapture cascades subject + thread + messages', () => {
    const cap = createCapture({ project_id: project.id, content: 'doomed' });
    deleteCapture(cap.id);

    const db = getMasterDatabase();
    expect(db.prepare(`SELECT 1 FROM captures WHERE id=?`).get(cap.id)).toBeUndefined();
    expect(db.prepare(
      `SELECT 1 FROM subjects WHERE subject_type='capture' AND subject_id=?`
    ).get(cap.id)).toBeUndefined();
    expect(db.prepare(
      `SELECT 1 FROM threads WHERE subject_type='capture' AND subject_id=?`
    ).get(cap.id)).toBeUndefined();
    expect(db.prepare(
      `SELECT COUNT(*) AS n FROM thread_messages`
    ).get().n).toBe(0);
  });
});
