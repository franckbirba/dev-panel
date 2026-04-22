import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { initMasterDatabase, createProject, getMasterDatabase } from '../../src/server/db.js';

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
