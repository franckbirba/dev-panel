import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject, getMasterDatabase, closeAllDatabases } from '../../src/server/db.js';
import {
  createWidgetSession,
  authorizeBySessionToken,
  isValidSessionId,
  closeWidgetSession,
  getWidgetSessionBySessionId
} from '../../src/server/widget-sessions.js';

describe('widget-sessions helpers', () => {
  let tmp, project;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devpanel-ws-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo' });
  });

  afterEach(() => {
    closeAllDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('createWidgetSession persists row + thread + subject', () => {
    const s = createWidgetSession({
      project_id: project.id,
      user_agent: 'Mozilla/5.0',
      route: '/dashboard',
      viewport_w: 1280,
      viewport_h: 720,
      locale: 'fr-FR'
    });
    expect(s.id).toBeTruthy();
    expect(s.session_id).toMatch(/^ws_/);
    expect(s.session_token).toMatch(/^wt_/);
    expect(s.thread_id).toBeGreaterThan(0);
    expect(s.token_expires_at).toBeTruthy();
    expect(new Date(s.token_expires_at).getTime()).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);

    const db = getMasterDatabase();
    const subj = db.prepare(`SELECT * FROM subjects WHERE subject_type='widget_session' AND subject_id=?`).get(s.id);
    expect(subj).toBeTruthy();
    const thread = db.prepare(`SELECT * FROM threads WHERE thread_id=?`).get(s.thread_id);
    expect(thread.subject_type).toBe('widget_session');
  });

  it('isValidSessionId enforces the [A-Za-z0-9_-]{6,128} pattern', () => {
    expect(isValidSessionId('ws_abcdefgh')).toBe(true);
    expect(isValidSessionId('short')).toBe(false);
    expect(isValidSessionId('has spaces')).toBe(false);
    expect(isValidSessionId(null)).toBe(false);
    expect(isValidSessionId(123)).toBe(false);
  });

  it('authorizeBySessionToken returns row + slides expiry on success', async () => {
    const s = createWidgetSession({ project_id: project.id });
    const beforeExpiry = new Date(s.token_expires_at).getTime();
    // Sleep a tick so the new expiry is strictly later (millisecond resolution).
    await new Promise(r => setTimeout(r, 5));
    const auth = authorizeBySessionToken({ session_id: s.session_id, token: s.session_token });
    expect(auth).toBeTruthy();
    expect(auth.id).toBe(s.id);
    expect(new Date(auth.token_expires_at).getTime()).toBeGreaterThan(beforeExpiry);
  });

  it('authorizeBySessionToken returns null on bad token / missing / closed', () => {
    const s = createWidgetSession({ project_id: project.id });
    expect(authorizeBySessionToken({ session_id: s.session_id, token: 'bogus' })).toBeNull();
    expect(authorizeBySessionToken({ session_id: 'nonexistent_session_id_xx', token: s.session_token })).toBeNull();
    expect(authorizeBySessionToken({ session_id: s.session_id, token: '' })).toBeNull();
    closeWidgetSession(s.id);
    expect(authorizeBySessionToken({ session_id: s.session_id, token: s.session_token })).toBeNull();
  });

  it('authorizeBySessionToken returns null when token is expired', () => {
    const s = createWidgetSession({ project_id: project.id });
    // Force expiry into the past.
    const db = getMasterDatabase();
    db.prepare(`UPDATE widget_sessions SET token_expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), s.id);
    expect(authorizeBySessionToken({ session_id: s.session_id, token: s.session_token })).toBeNull();
  });

  it('rejects bad session_id shape on authorize', () => {
    const s = createWidgetSession({ project_id: project.id });
    expect(authorizeBySessionToken({ session_id: 'has space', token: s.session_token })).toBeNull();
  });

  it('getWidgetSessionBySessionId looks up by public id', () => {
    const s = createWidgetSession({ project_id: project.id });
    const found = getWidgetSessionBySessionId(s.session_id);
    expect(found.id).toBe(s.id);
    expect(getWidgetSessionBySessionId('ws_nonexistent_xx')).toBeNull();
  });
});
