// tests/server/widget-audit.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { initMasterDatabase, createProject, getMasterDatabase } from '../../src/server/db.js';
import {
  auditEvent,
  hashContent,
  AUDIT_TYPES,
  listAuditForSession
} from '../../src/server/widget-audit.js';

describe('widget-audit', () => {
  let project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-audit-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'audit-test', github_owner: 'o', github_repo: 'r' });
  });

  it('writes a row with hashed content (no plaintext)', () => {
    const id = auditEvent({
      project_id: project.id,
      session_id: 'sess-1',
      type: AUDIT_TYPES.MESSAGE_IN,
      content: 'hello world'
    });
    expect(id).toBeGreaterThan(0);

    const db = getMasterDatabase();
    const row = db.prepare('SELECT * FROM widget_audit WHERE id = ?').get(id);
    expect(row.project_id).toBe(project.id);
    expect(row.session_id).toBe('sess-1');
    expect(row.type).toBe('message_in');
    expect(row.content_hash).toBe(createHash('sha256').update('hello world').digest('hex'));

    // Plaintext must NOT appear anywhere on the row.
    expect(JSON.stringify(row)).not.toContain('hello world');
  });

  it('accepts every documented type', () => {
    for (const t of Object.values(AUDIT_TYPES)) {
      auditEvent({ project_id: project.id, session_id: 's', type: t });
    }
    const db = getMasterDatabase();
    const rows = db.prepare(
      `SELECT type FROM widget_audit WHERE session_id = 's' ORDER BY id`
    ).all();
    expect(rows.map(r => r.type)).toEqual([
      'message_in', 'message_out', 'capture_created', 'rate_limited', 'redacted'
    ]);
  });

  it('rejects unknown types', () => {
    expect(() => auditEvent({
      project_id: project.id, session_id: 's', type: 'frobnicate'
    })).toThrow(/invalid type/);
  });

  it('content is optional — a null hash is stored when omitted', () => {
    const id = auditEvent({
      project_id: project.id,
      session_id: 'sess-2',
      type: AUDIT_TYPES.RATE_LIMITED
    });
    const db = getMasterDatabase();
    const row = db.prepare('SELECT * FROM widget_audit WHERE id = ?').get(id);
    expect(row.content_hash).toBeNull();
  });

  it('hashContent is stable and deterministic', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
    expect(hashContent(null)).toBeNull();
  });

  it('listAuditForSession returns rows newest-first', () => {
    auditEvent({ project_id: project.id, session_id: 'A', type: AUDIT_TYPES.MESSAGE_IN, content: 'one' });
    auditEvent({ project_id: project.id, session_id: 'A', type: AUDIT_TYPES.MESSAGE_IN, content: 'two' });
    auditEvent({ project_id: project.id, session_id: 'B', type: AUDIT_TYPES.MESSAGE_IN, content: 'other' });

    const rows = listAuditForSession('A');
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBeGreaterThan(rows[1].id);
    expect(rows.every(r => r.session_id === 'A')).toBe(true);
  });
});
