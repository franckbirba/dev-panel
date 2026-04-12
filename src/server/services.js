import { getTicket, updateTicket, logActivity } from './db.js';
import { initGitHub, createIssue, formatTicketAsIssue } from './github.js';
import { broadcast } from './sse.js';

export async function publishTicket(storagePath, projectId, ticketId, { githubConfig, title, labels, assignee }) {
  const ticket = getTicket(storagePath, projectId, ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
  if (ticket.status === 'published') throw new Error(`Ticket ${ticketId} already published`);

  const token = process.env.GITHUB_TOKEN || githubConfig.token;
  if (!token) throw new Error('GitHub token not configured');
  initGitHub(token);

  const issueData = formatTicketAsIssue(ticket, githubConfig);
  if (title) issueData.title = title;
  if (labels) issueData.labels = labels;
  if (assignee) issueData.assignees = [assignee];

  const issue = await createIssue(issueData);

  updateTicket(storagePath, projectId, ticketId, {
    status: 'published',
    github_issue_number: issue.number,
    github_issue_url: issue.html_url,
    github_synced_at: new Date().toISOString(),
    reviewed_at: new Date().toISOString(),
  });

  logActivity(storagePath, projectId, {
    action: 'published',
    ticketId,
    detail: `→ GitHub issue #${issue.number}`,
  });
  broadcast('ticket:published', { id: ticketId, issueNumber: issue.number, issueUrl: issue.html_url });

  return issue;
}

export function rejectTicket(storagePath, projectId, ticketId, reason = 'Not applicable') {
  const ticket = getTicket(storagePath, projectId, ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
  if (ticket.status === 'rejected') throw new Error(`Ticket ${ticketId} already rejected`);

  updateTicket(storagePath, projectId, ticketId, {
    status: 'rejected',
    rejection_reason: reason,
    reviewed_at: new Date().toISOString(),
  });

  logActivity(storagePath, projectId, {
    action: 'rejected',
    ticketId,
    detail: reason,
  });
  broadcast('ticket:updated', { id: ticketId, status: 'rejected' });

  return { id: ticketId, status: 'rejected' };
}
