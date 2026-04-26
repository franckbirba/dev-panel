import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { initMasterDatabase, getMasterDatabase, initProjectDatabase } from '../../src/server/db.js';

describe('signal-inbox schema', () => {
  let tmpDir;
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'devpanel-schema-'));
    initMasterDatabase(tmpDir);
  });

  it('creates subjects table with priority column and indexes', () => {
    const db = getMasterDatabase();
    const cols = db.prepare("PRAGMA table_info(subjects)").all().map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'subject_type', 'subject_id', 'project_id', 'title', 'priority', 'priority_set_at', 'created_at'
    ]));
    const indexes = db.prepare("PRAGMA index_list(subjects)").all().map(i => i.name);
    expect(indexes).toEqual(expect.arrayContaining(['subjects_priority', 'subjects_project']));
  });

  it('creates threads table with unique (subject_type, subject_id)', () => {
    const db = getMasterDatabase();
    const cols = db.prepare("PRAGMA table_info(threads)").all().map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'thread_id', 'subject_type', 'subject_id', 'project_id', 'created_at', 'last_message_at'
    ]));
    const idxList = db.prepare("PRAGMA index_list(threads)").all();
    const uniqIdx = idxList.find(i => i.unique === 1);
    expect(uniqIdx).toBeDefined();
    const cols2 = db.prepare(`PRAGMA index_info(${uniqIdx.name})`).all().map(c => c.name);
    expect(cols2.sort()).toEqual(['subject_id', 'subject_type'].sort());
  });

  it('creates thread_messages table with telegram dedup index', () => {
    const db = getMasterDatabase();
    const cols = db.prepare("PRAGMA table_info(thread_messages)").all().map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'thread_id', 'role', 'source', 'content', 'telegram_message_id', 'created_at'
    ]));
    const indexes = db.prepare("PRAGMA index_list(thread_messages)").all().map(i => i.name);
    expect(indexes).toEqual(expect.arrayContaining(['thread_messages_thread', 'thread_messages_tg_dedup']));
  });

  it('creates deploy_events table indexed by project + created_at', () => {
    const db = getMasterDatabase();
    const cols = db.prepare("PRAGMA table_info(deploy_events)").all().map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'project_id', 'status', 'sha', 'ref', 'log_url', 'failed_reason', 'started_at', 'finished_at', 'created_at'
    ]));
    const indexes = db.prepare("PRAGMA index_list(deploy_events)").all().map(i => i.name);
    expect(indexes).toEqual(expect.arrayContaining(['deploy_events_project_created']));
  });

  it('tickets table has routed_label, routed_member_id, routed_at columns after initProjectDatabase', () => {
    const projectTmpDir = mkdtempSync(join(tmpdir(), 'devpanel-tickets-'));
    try {
      initProjectDatabase(projectTmpDir, 'test-project');
      const ticketDb = new Database(join(projectTmpDir, 'test-project', 'tickets.db'));
      const cols = ticketDb.prepare("PRAGMA table_info(tickets)").all().map(c => c.name);
      expect(cols).toEqual(expect.arrayContaining(['routed_label', 'routed_member_id', 'routed_at']));
      ticketDb.close();
    } finally {
      rmSync(projectTmpDir, { recursive: true, force: true });
    }
  });
});
