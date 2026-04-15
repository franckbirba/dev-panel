import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getProjectDatabase,
  createTicket,
  listTickets,
  searchTickets
} from '../../src/server/db.js';

const storagePath = mkdtempSync(join(tmpdir(), 'dp-tf-'));
const projectId = 'test-project';

beforeAll(() => {
  getProjectDatabase(storagePath, projectId);

  createTicket(storagePath, projectId, {
    type: 'bug', title: 'Login page crashes', description: 'The login page crashes on submit',
    created_by: 'alice'
  });
  createTicket(storagePath, projectId, {
    type: 'feature', title: 'Add dark mode', description: 'Users want dark mode support',
    created_by: 'bob'
  });
  createTicket(storagePath, projectId, {
    type: 'bug', title: 'Memory leak in dashboard', description: 'Dashboard uses too much memory over time',
    created_by: 'alice'
  });
  createTicket(storagePath, projectId, {
    type: 'feature', title: 'Export to CSV', description: 'Allow exporting ticket data to CSV files',
    created_by: 'charlie'
  });
});

describe('listTickets filters', () => {
  it('returns all tickets when no filters applied', () => {
    const tickets = listTickets(storagePath, projectId);
    expect(tickets).toHaveLength(4);
  });

  it('filters by type=bug', () => {
    const tickets = listTickets(storagePath, projectId, { type: 'bug' });
    expect(tickets).toHaveLength(2);
    expect(tickets.every(t => t.type === 'bug')).toBe(true);
  });

  it('filters by type=feature', () => {
    const tickets = listTickets(storagePath, projectId, { type: 'feature' });
    expect(tickets).toHaveLength(2);
    expect(tickets.every(t => t.type === 'feature')).toBe(true);
  });

  it('filters by status', () => {
    const tickets = listTickets(storagePath, projectId, { status: 'pending' });
    expect(tickets).toHaveLength(4);
  });

  it('combines type and status filters', () => {
    const tickets = listTickets(storagePath, projectId, { type: 'bug', status: 'pending' });
    expect(tickets).toHaveLength(2);
  });

  it('sorts by created_at ascending', () => {
    const tickets = listTickets(storagePath, projectId, { sort: 'created_at', order: 'asc' });
    expect(tickets[0].title).toBe('Login page crashes');
    expect(tickets[3].title).toBe('Export to CSV');
  });

  it('sorts by created_at descending (default)', () => {
    const tickets = listTickets(storagePath, projectId);
    expect(tickets).toHaveLength(4);
  });

  it('sorts by title ascending', () => {
    const tickets = listTickets(storagePath, projectId, { sort: 'title', order: 'asc' });
    expect(tickets[0].title).toBe('Add dark mode');
    expect(tickets[3].title).toBe('Memory leak in dashboard');
  });

  it('sorts by type', () => {
    const tickets = listTickets(storagePath, projectId, { sort: 'type', order: 'asc' });
    expect(tickets[0].type).toBe('bug');
    expect(tickets[1].type).toBe('bug');
  });

  it('supports offset for pagination', () => {
    const tickets = listTickets(storagePath, projectId, { limit: 2, offset: 2 });
    expect(tickets).toHaveLength(2);
  });

  it('ignores invalid sort fields', () => {
    const tickets = listTickets(storagePath, projectId, { sort: 'DROP TABLE;--' });
    expect(tickets).toHaveLength(4);
  });
});

describe('searchTickets (FTS5)', () => {
  it('finds tickets by title keyword', () => {
    const results = searchTickets(storagePath, projectId, 'login');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toContain('Login');
  });

  it('finds tickets by description keyword', () => {
    const results = searchTickets(storagePath, projectId, 'memory');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.title.includes('Memory'))).toBe(true);
  });

  it('returns empty array for no match', () => {
    const results = searchTickets(storagePath, projectId, 'zzzznonexistent');
    expect(results).toHaveLength(0);
  });

  it('respects limit', () => {
    const results = searchTickets(storagePath, projectId, 'the OR mode OR CSV', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });
});
