import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { initMasterDatabase, closeAllDatabases } from '../../src/server/db.js';

describe('captures environment migration (v4)', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-envmig-'));
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('adds environment column to captures', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    const cols = new Set(raw.prepare('PRAGMA table_info(captures)').all().map(c => c.name));
    expect(cols.has('environment')).toBe(true);
    raw.close();
  });

  it('creates idx_captures_environment index', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    const idx = new Set(raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='captures'`
    ).all().map(r => r.name));
    expect(idx.has('idx_captures_environment')).toBe(true);
    raw.close();
  });

  it('bumps user_version to at least 4', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    const v = raw.pragma('user_version', { simple: true });
    expect(v).toBeGreaterThanOrEqual(4);
    raw.close();
  });

  it('is idempotent: running init twice does not throw', () => {
    initMasterDatabase(tmp);
    closeAllDatabases();
    expect(() => initMasterDatabase(tmp)).not.toThrow();
  });
});
