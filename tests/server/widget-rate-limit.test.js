// tests/server/widget-rate-limit.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject } from '../../src/server/db.js';
import { auditEvent, AUDIT_TYPES } from '../../src/server/widget-audit.js';
import { checkRateLimit, LIMITS } from '../../src/server/widget-rate-limit.js';

describe('widget-rate-limit', () => {
  let project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-rl-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'rl-test', github_owner: 'o', github_repo: 'r' });
  });

  function fillSession(session_id, count) {
    for (let i = 0; i < count; i++) {
      auditEvent({
        project_id: project.id,
        session_id,
        type: AUDIT_TYPES.MESSAGE_IN,
        content: `msg ${i}`
      });
    }
  }

  it('allows the first request from a fresh session', () => {
    const r = checkRateLimit({ project_id: project.id, session_id: 'fresh' });
    expect(r.allowed).toBe(true);
  });

  it('throws when session_id is missing', () => {
    expect(() => checkRateLimit({ project_id: project.id, session_id: '' }))
      .toThrow(/session_id required/);
  });

  it('rejects the 31st message in a minute (per-session per-min)', () => {
    fillSession('chatty', LIMITS.PER_SESSION_PER_MIN);
    const r = checkRateLimit({ project_id: project.id, session_id: 'chatty' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('per_session_per_min');
    expect(r.retryAfter).toBe(60);
    expect(r.counts.minute).toBe(LIMITS.PER_SESSION_PER_MIN);
  });

  it('still rejects a chatty session even if a different session is quiet', () => {
    fillSession('chatty', LIMITS.PER_SESSION_PER_MIN);
    fillSession('quiet', 1);
    expect(checkRateLimit({ project_id: project.id, session_id: 'chatty' }).allowed).toBe(false);
    expect(checkRateLimit({ project_id: project.id, session_id: 'quiet' }).allowed).toBe(true);
  });

  it('rejects the 201st daily message even if the per-min count is fine', async () => {
    // Backdate 200 minute-old messages so the per-min check passes but the
    // per-day count trips. We do that by inserting straight into the table
    // with a custom timestamp.
    const { getMasterDatabase } = await import('../../src/server/db.js');
    const db = getMasterDatabase();
    const insert = db.prepare(
      `INSERT INTO widget_audit (project_id, session_id, type, content_hash, ts)
       VALUES (?, ?, 'message_in', 'h', datetime('now', '-' || ? || ' seconds'))`
    );
    for (let i = 0; i < LIMITS.PER_SESSION_PER_DAY; i++) {
      // spread between 5 minutes and 23 hours ago
      const offset = 300 + i * 100;
      insert.run(project.id, 'long-running', offset);
    }

    const r = checkRateLimit({ project_id: project.id, session_id: 'long-running' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('per_session_per_day');
    expect(r.retryAfter).toBe(24 * 3600);
  });

  it('rejects a brand-new (1001st) session when the project is at the concurrent cap', () => {
    // Lower the cap for a fast test, keep the active window short so the
    // 1000-row insert is cheap.
    const limits = {
      ...LIMITS,
      PER_PROJECT_CONCURRENT_SESSIONS: 5,
      SESSION_ACTIVE_WINDOW_SEC: 60
    };
    for (let i = 0; i < limits.PER_PROJECT_CONCURRENT_SESSIONS; i++) {
      auditEvent({
        project_id: project.id,
        session_id: `s-${i}`,
        type: AUDIT_TYPES.MESSAGE_IN,
        content: 'hi'
      });
    }

    const r = checkRateLimit(
      { project_id: project.id, session_id: 's-NEW' },
      limits
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('per_project_concurrent_sessions');
    expect(r.retryAfter).toBe(limits.SESSION_ACTIVE_WINDOW_SEC);
    expect(r.counts.active_sessions).toBe(limits.PER_PROJECT_CONCURRENT_SESSIONS);
  });

  it('lets an already-active session keep posting even when the project cap is full', () => {
    const limits = {
      ...LIMITS,
      PER_PROJECT_CONCURRENT_SESSIONS: 3,
      SESSION_ACTIVE_WINDOW_SEC: 60
    };
    for (let i = 0; i < limits.PER_PROJECT_CONCURRENT_SESSIONS; i++) {
      auditEvent({
        project_id: project.id,
        session_id: `s-${i}`,
        type: AUDIT_TYPES.MESSAGE_IN,
        content: 'hi'
      });
    }
    // s-0 is already established, so it should still pass even though the
    // project is "full".
    const r = checkRateLimit(
      { project_id: project.id, session_id: 's-0' },
      limits
    );
    expect(r.allowed).toBe(true);
  });

  it('per-session checks fire BEFORE the per-project cap', () => {
    // Even when a session is established, hitting the per-min cap returns
    // per_session_per_min — order matters because the front-end displays
    // a different message for each kind.
    const limits = { ...LIMITS, PER_SESSION_PER_MIN: 2, PER_PROJECT_CONCURRENT_SESSIONS: 1 };
    fillSession('s-0', 2);
    const r = checkRateLimit({ project_id: project.id, session_id: 's-0' }, limits);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('per_session_per_min');
  });
});
