import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { initMasterDatabase, closeAllDatabases } from '../../src/server/db.js';

describe('captures reporter migration (v3)', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-repmig-'));
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('adds reporter_id, reporter_name, reporter_email, reporter_extra columns to captures', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    const cols = new Set(raw.prepare('PRAGMA table_info(captures)').all().map(c => c.name));
    expect(cols.has('reporter_id')).toBe(true);
    expect(cols.has('reporter_name')).toBe(true);
    expect(cols.has('reporter_email')).toBe(true);
    expect(cols.has('reporter_extra')).toBe(true);
  });

  it('creates idx_captures_reporter_id and idx_captures_reporter_email indexes', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    const idx = new Set(raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='captures'`
    ).all().map(r => r.name));
    expect(idx.has('idx_captures_reporter_id')).toBe(true);
    expect(idx.has('idx_captures_reporter_email')).toBe(true);
  });

  it('bumps user_version to at least 3', () => {
    initMasterDatabase(tmp);
    const raw = new Database(join(tmp, 'projects.db'));
    const v = raw.pragma('user_version', { simple: true });
    expect(v).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent: running init twice does not throw', () => {
    initMasterDatabase(tmp);
    closeAllDatabases();
    expect(() => initMasterDatabase(tmp)).not.toThrow();
  });
});
