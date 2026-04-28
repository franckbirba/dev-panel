import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import {
  initMasterDatabase,
  closeAllDatabases,
  createProject,
} from '../../src/server/db.js';

describe('widget_sessions schema (v7 migration)', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-widget-sessions-'));
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates widget_sessions table with all required columns', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    try {
      const cols = new Set(
        raw.prepare('PRAGMA table_info(widget_sessions)').all().map(c => c.name)
      );
      for (const col of [
        'id',
        'project_id',
        'session_token',
        'thread_id',
        'user_agent',
        'route',
        'viewport_w',
        'viewport_h',
        'locale',
        'started_at',
        'last_seen_at',
        'closed_at',
      ]) {
        expect(cols.has(col), `missing column ${col}`).toBe(true);
      }
    } finally {
      raw.close();
    }
  });

  it('enforces UNIQUE on session_token', () => {
    initMasterDatabase(tmp);
    const project = createProject({ name: 'wsess-uniq' });
    const raw = new Database(join(tmp, 'projects.db'));
    raw.pragma('foreign_keys = ON');
    try {
      const insert = raw.prepare(
        `INSERT INTO widget_sessions (id, project_id, session_token) VALUES (?, ?, ?)`
      );
      insert.run('ws_a', project.id, 'tok_dup');
      expect(() => insert.run('ws_b', project.id, 'tok_dup')).toThrow(/UNIQUE/i);
    } finally {
      raw.close();
    }
  });

  it('creates idx_widget_sessions_project and idx_widget_sessions_last_seen indexes', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    try {
      const idx = new Set(
        raw
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='widget_sessions'`
          )
          .all()
          .map(r => r.name)
      );
      expect(idx.has('idx_widget_sessions_project')).toBe(true);
      expect(idx.has('idx_widget_sessions_last_seen')).toBe(true);
    } finally {
      raw.close();
    }
  });

  it('INSERT into widget_sessions with valid project_id FK succeeds', () => {
    initMasterDatabase(tmp);
    const project = createProject({ name: 'wsess-ok' });

    const raw = new Database(join(tmp, 'projects.db'));
    raw.pragma('foreign_keys = ON');
    try {
      const stmt = raw.prepare(`
        INSERT INTO widget_sessions (
          id, project_id, session_token, user_agent, route,
          viewport_w, viewport_h, locale
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        'ws_test_1',
        project.id,
        'tok_abc',
        'Mozilla/5.0',
        '/dashboard',
        1280,
        720,
        'en-US'
      );
      expect(result.changes).toBe(1);

      const row = raw
        .prepare('SELECT * FROM widget_sessions WHERE id = ?')
        .get('ws_test_1');
      expect(row.project_id).toBe(project.id);
      expect(row.session_token).toBe('tok_abc');
      expect(row.viewport_w).toBe(1280);
      expect(row.started_at).toBeTruthy(); // default CURRENT_TIMESTAMP
    } finally {
      raw.close();
    }
  });

  it('INSERT into widget_sessions with invalid project_id FK fails', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    raw.pragma('foreign_keys = ON');
    try {
      const stmt = raw.prepare(`
        INSERT INTO widget_sessions (id, project_id, session_token)
        VALUES (?, ?, ?)
      `);
      expect(() =>
        stmt.run('ws_bad', 'project-that-does-not-exist', 'tok_bad')
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      raw.close();
    }
  });
});

describe('captures source + widget_session_id columns (v7 migration)', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-captures-source-'));
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('adds source and widget_session_id columns to captures', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    try {
      const cols = new Set(
        raw.prepare('PRAGMA table_info(captures)').all().map(c => c.name)
      );
      expect(cols.has('source')).toBe(true);
      expect(cols.has('widget_session_id')).toBe(true);
    } finally {
      raw.close();
    }
  });

  it('existing captures rows have source = "dashboard" and widget_session_id = NULL after migration', () => {
    // Step 1: bootstrap a pre-v7 database manually (simulate existing data).
    // We open a raw db at the path initMasterDatabase will use, create a
    // minimal projects/captures schema, insert one capture, set user_version
    // to 6 (last pre-widget-sessions version), then close.
    const dbPath = join(tmp, 'projects.db');
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        api_key TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE captures (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'idea',
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        plane_work_item_id TEXT,
        plane_sequence_id INTEGER,
        created_by TEXT DEFAULT 'franck',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    seed.prepare(`INSERT INTO projects (id, name, api_key) VALUES (?, ?, ?)`)
      .run('proj-old', 'old-project', 'dp_old_key');
    seed.prepare(
      `INSERT INTO captures (id, project_id, content) VALUES (?, ?, ?)`
    ).run('cap-pre-v7', 'proj-old', 'pre-existing capture');
    seed.pragma('user_version = 6');
    seed.close();

    // Step 2: run init — migrations should fire.
    initMasterDatabase(tmp);

    // Step 3: verify the existing row has the migration defaults.
    const raw = new Database(dbPath);
    try {
      const row = raw
        .prepare('SELECT source, widget_session_id FROM captures WHERE id = ?')
        .get('cap-pre-v7');
      expect(row.source).toBe('dashboard');
      expect(row.widget_session_id).toBeNull();
    } finally {
      raw.close();
    }
  });

  it('widget_session_id has FK to widget_sessions(id)', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    try {
      const fks = raw.prepare('PRAGMA foreign_key_list(captures)').all();
      const wsFk = fks.find(fk => fk.table === 'widget_sessions');
      expect(wsFk).toBeDefined();
      expect(wsFk.from).toBe('widget_session_id');
      expect(wsFk.to).toBe('id');
    } finally {
      raw.close();
    }
  });
});

describe('thread_messages source rename (v7 migration)', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-tm-source-'));
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('rewrites pre-existing source = "web" rows to "dashboard"', () => {
    // Bootstrap a pre-v7 database with a thread_message at source='web'.
    // We piggyback on an early init, write the row, close, then run init
    // again to fire the v7 migration.
    initMasterDatabase(tmp);
    const dbPath = join(tmp, 'projects.db');

    // Force version back to 6 so v7 fires fresh.
    const tweak = new Database(dbPath);
    tweak.prepare(`INSERT INTO projects (id, name, api_key) VALUES (?, ?, ?)`)
      .run('proj-tm', 'tm-project', 'dp_tm_key');
    tweak.prepare(`
      INSERT INTO threads (subject_type, subject_id, project_id) VALUES (?, ?, ?)
    `).run('capture', 'cap-tm', 'proj-tm');
    const tid = tweak.prepare(
      `SELECT thread_id FROM threads WHERE subject_id = 'cap-tm'`
    ).get().thread_id;
    tweak.prepare(`
      INSERT INTO thread_messages (thread_id, role, source, content)
      VALUES (?, 'user', 'web', 'old-web-msg')
    `).run(tid);
    tweak.prepare(`
      INSERT INTO thread_messages (thread_id, role, source, content)
      VALUES (?, 'user', 'telegram', 'old-tg-msg')
    `).run(tid);
    tweak.pragma('user_version = 6');
    tweak.close();
    closeAllDatabases();

    initMasterDatabase(tmp);

    const raw = new Database(dbPath);
    try {
      const webRow = raw
        .prepare(`SELECT source FROM thread_messages WHERE content = 'old-web-msg'`)
        .get();
      expect(webRow.source).toBe('dashboard');

      const tgRow = raw
        .prepare(`SELECT source FROM thread_messages WHERE content = 'old-tg-msg'`)
        .get();
      expect(tgRow.source).toBe('telegram');
    } finally {
      raw.close();
    }
  });
});

describe('v7 migration metadata', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-v7-meta-'));
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('bumps user_version to at least 7', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    try {
      const v = raw.pragma('user_version', { simple: true });
      expect(v).toBeGreaterThanOrEqual(7);
    } finally {
      raw.close();
    }
  });

  it('is idempotent: running init twice does not throw', () => {
    initMasterDatabase(tmp);
    closeAllDatabases();
    expect(() => initMasterDatabase(tmp)).not.toThrow();
  });
});
