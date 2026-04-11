import { Octokit } from 'octokit';

let octokit = null;

export function initGitHub(token) {
  octokit = new Octokit({ auth: token });
  return octokit;
}

export function getGitHub() {
  if (!octokit) {
    throw new Error('GitHub not initialized. Call initGitHub() first.');
  }
  return octokit;
}

export async function createIssue({ owner, repo, title, body, labels = [], assignees = [] }) {
  const { data } = await octokit.rest.issues.create({
    owner,
    repo,
    title,
    body,
    labels,
    assignees
  });

  return data;
}

export async function getIssue({ owner, repo, issue_number }) {
  const { data } = await octokit.rest.issues.get({
    owner,
    repo,
    issue_number
  });

  return data;
}

export async function updateIssue({ owner, repo, issue_number, title, body, labels, assignees, state }) {
  const updateData = {};

  if (title !== undefined) updateData.title = title;
  if (body !== undefined) updateData.body = body;
  if (labels !== undefined) updateData.labels = labels;
  if (assignees !== undefined) updateData.assignees = assignees;
  if (state !== undefined) updateData.state = state;

  const { data } = await octokit.rest.issues.update({
    owner,
    repo,
    issue_number,
    ...updateData
  });

  return data;
}

export async function listIssues({ owner, repo, state = 'open', labels, assignee, since }) {
  const params = {
    owner,
    repo,
    state,
    per_page: 100
  };

  if (labels) params.labels = labels;
  if (assignee) params.assignee = assignee;
  if (since) params.since = since;

  const { data } = await octokit.rest.issues.listForRepo(params);
  return data;
}

export async function fetchMilestones({ owner, repo, state = 'all' }) {
  const { data } = await octokit.rest.issues.listMilestones({
    owner, repo, state, per_page: 100
  });

  return data.map(m => ({
    github_id: m.number,
    title: m.title,
    description: m.description,
    state: m.state,
    due_on: m.due_on,
    open_issues: m.open_issues,
    closed_issues: m.closed_issues,
    github_url: m.html_url
  }));
}

export async function fetchRepoDocs({ owner, repo }) {
  const { data: tree } = await octokit.rest.git.getTree({
    owner, repo, tree_sha: 'HEAD', recursive: '1'
  });

  const mdFiles = tree.tree.filter(f =>
    f.type === 'blob' && f.path.endsWith('.md')
  );

  const docs = [];
  for (const file of mdFiles) {
    const { data } = await octokit.rest.repos.getContent({
      owner, repo, path: file.path
    });

    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    docs.push({ path: file.path, content, sha: file.sha });
  }

  return docs;
}

export function formatTicketAsIssue(ticket, config = {}) {
  const { title, description, context, type, created_by, screenshot_path } = ticket;

  // Format title
  const prefix = type === 'bug' ? '[BUG]' : '[FEATURE]';
  const formattedTitle = title.startsWith('[') ? title : `${prefix} ${title}`;

  // Format body
  let body = '';

  if (type === 'bug') {
    body += `## Description\n${description}\n\n`;

    if (context?.url) {
      body += `## Steps to Reproduce\n`;
      body += `1. Navigate to ${context.url}\n`;
      body += `2. (Add more steps based on description)\n\n`;
    }

    body += `## Expected Behavior\n(To be filled)\n\n`;
    body += `## Actual Behavior\n${description}\n\n`;
  } else {
    body += `## Feature Request\n${description}\n\n`;
    body += `## Use Case\n(To be filled)\n\n`;
    body += `## Proposed Solution\n(To be filled)\n\n`;
  }

  // Add context
  body += `## Context\n`;
  if (created_by) body += `- **Reporter**: ${created_by}\n`;
  if (context?.url) body += `- **URL**: ${context.url}\n`;
  if (context?.userAgent) body += `- **User Agent**: ${context.userAgent}\n`;
  if (context?.timestamp) body += `- **Timestamp**: ${new Date(context.timestamp).toISOString()}\n`;
  body += `\n`;

  // Add screenshot
  if (screenshot_path) {
    body += `## Screenshot\n`;
    body += `![Screenshot](${screenshot_path})\n\n`;
  }

  // Footer
  body += `---\n`;
  body += `*Auto-generated from internal ticket #${ticket.id}*\n`;

  return {
    title: formattedTitle,
    body,
    labels: config.labels || (type === 'bug' ? ['bug', 'needs-triage'] : ['enhancement', 'feature-request'])
  };
}
