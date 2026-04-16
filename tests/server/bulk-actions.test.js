import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  initMasterDatabase, createProject, initProjectDatabase,
  createTicket, getTicket, listActivity
} from '../../src/server/db.js';
import { bulkReject, validateBulkPayload } from '../../src/server/bulk.js';

let storagePath;
let projectId;

beforeAll(() => {
  storagePath = mkdtempSync(join(tmpdir(), 'dp-bulk-'));
  initMasterDatabase(storagePath);
  const project = createProject({ name: 'bulk-test' });
  projectId = project.id;
  initProjectDatabase(storagePath, projectId);
});

function seedTickets(count = 5) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = createTicket(storagePath, projectId, {
      type: 'bug',
      title: `Ticket ${i + 1}`,
      description: `Description ${i + 1}`,
    });
    ids.push(Number(id));
  }
  return ids;
}

describe('validateBulkPayload', () => {
  it('rejects missing action', () => {
    const err = validateBulkPayload({ ids: [1] });
    expect(err).toContain('action');
  });

  it('rejects invalid action', () => {
    const err = validateBulkPayload({ action: 'delete', ids: [1] });
    expect(err).toContain('action');
  });

  it('rejects missing ids', () => {
    const err = validateBulkPayload({ action: 'reject' });
    expect(err).toContain('ids');
  });

  it('rejects empty ids array', () => {
    const err = validateBulkPayload({ action: 'reject', ids: [] });
    expect(err).toContain('ids');
  });

  it('rejects non-integer ids', () => {
    const err = validateBulkPayload({ action: 'reject', ids: ['abc'] });
    expect(err).toContain('integers');
  });

  it('caps at 50 ids', () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1);
    const err = validateBulkPayload({ action: 'reject', ids });
    expect(err).toContain('50');
  });

  it('returns null for valid payload', () => {
    expect(validateBulkPayload({ action: 'reject', ids: [1, 2, 3] })).toBeNull();
    expect(validateBulkPayload({ action: 'publish', ids: [1] })).toBeNull();
  });
});

describe('bulkReject', () => {
  it('rejects multiple pending tickets', () => {
    const ids = seedTickets(3);
    const result = bulkReject(storagePath, projectId, ids, 'Bulk rejected');

    expect(result.succeeded).toHaveLength(3);
    expect(result.failed).toHaveLength(0);

    for (const id of ids) {
      const t = getTicket(storagePath, projectId, id);
      expect(t.status).toBe('rejected');
      expect(t.rejection_reason).toBe('Bulk rejected');
    }
  });

  it('reports already-rejected tickets as failed', () => {
    const ids = seedTickets(2);
    bulkReject(storagePath, projectId, [ids[0]], 'First pass');

    const result = bulkReject(storagePath, projectId, ids, 'Second pass');
    expect(result.succeeded).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe(ids[0]);
    expect(result.failed[0].error).toContain('already rejected');
  });

  it('reports non-existent tickets as failed', () => {
    const result = bulkReject(storagePath, projectId, [99999], 'nope');
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe(99999);
    expect(result.failed[0].error).toContain('not found');
  });

  it('logs activity for each rejected ticket', () => {
    const ids = seedTickets(2);
    bulkReject(storagePath, projectId, ids, 'Bulk reason');

    const activities = listActivity(storagePath, projectId, 100);
    for (const id of ids) {
      const entry = activities.find(a => a.ticket_id === id && a.action === 'rejected');
      expect(entry).toBeDefined();
    }
  });

  it('uses default reason when none provided', () => {
    const ids = seedTickets(1);
    bulkReject(storagePath, projectId, ids);

    const t = getTicket(storagePath, projectId, ids[0]);
    expect(t.rejection_reason).toBe('Bulk action');
  });
});
