import { getTicket, updateTicket, logActivity } from './db.js';
import { broadcast } from './sse.js';
import { publishTicket } from './services.js';

const VALID_ACTIONS = new Set(['publish', 'reject']);
const MAX_IDS = 50;

export function validateBulkPayload({ action, ids } = {}) {
  if (!action || !VALID_ACTIONS.has(action)) {
    return `Invalid action — must be one of: ${[...VALID_ACTIONS].join(', ')}`;
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return 'ids must be a non-empty array';
  }
  if (ids.length > MAX_IDS) {
    return `Too many ids — maximum is ${MAX_IDS}`;
  }
  if (!ids.every(id => Number.isInteger(id))) {
    return 'All ids must be integers';
  }
  return null;
}

export function bulkReject(storagePath, projectId, ids, reason = 'Bulk action') {
  const succeeded = [];
  const failed = [];
  const now = new Date().toISOString();

  for (const id of ids) {
    const ticket = getTicket(storagePath, projectId, id);
    if (!ticket) {
      failed.push({ id, error: `Ticket ${id} not found` });
      continue;
    }
    if (ticket.status === 'rejected') {
      failed.push({ id, error: `Ticket ${id} already rejected` });
      continue;
    }

    updateTicket(storagePath, projectId, id, {
      status: 'rejected',
      rejection_reason: reason,
      reviewed_at: now,
    });
    logActivity(storagePath, projectId, {
      action: 'rejected',
      ticketId: id,
      detail: reason,
    });
    broadcast('ticket:updated', { id, status: 'rejected' });
    succeeded.push(id);
  }

  return { succeeded, failed };
}

export async function bulkPublish(storagePath, projectId, ids, githubConfig) {
  const succeeded = [];
  const failed = [];

  for (const id of ids) {
    try {
      const issue = await publishTicket(storagePath, projectId, id, { githubConfig });
      succeeded.push({ id, issue: { number: issue.number, url: issue.html_url } });
    } catch (err) {
      failed.push({ id, error: err.message });
    }
  }

  return { succeeded, failed };
}
