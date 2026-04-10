import { Command } from 'commander';
import { join } from 'path';
import { readFileSync } from 'fs';

export const publishCommand = new Command('publish')
  .description('Publish ticket as GitHub issue')
  .argument('<id>', 'Ticket ID to publish')
  .option('-t, --title <title>', 'Override issue title')
  .option('-l, --labels <labels>', 'Comma-separated labels')
  .option('-a, --assignee <assignee>', 'GitHub username to assign')
  .action(async (id, options) => {
    const cwd = process.cwd();
    const configPath = join(cwd, '.devpanelrc.json');

    try {
      // Load config
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));

      // Check GitHub config
      if (!config.github.owner || !config.github.repo) {
        console.error('GitHub repository not configured in .devpanelrc.json');
        process.exit(1);
      }

      const githubToken = process.env.GITHUB_TOKEN || config.github.token;
      if (!githubToken || githubToken === '${GITHUB_TOKEN}') {
        console.error('GITHUB_TOKEN not set. Set it in .env.local or environment.');
        process.exit(1);
      }

      // Initialize DB and GitHub
      const { initDatabase, getTicket, updateTicket } = await import('../../server/db.js');
      const { initGitHub, createIssue, formatTicketAsIssue } = await import('../../server/github.js');

      initDatabase(config.storage.path);
      initGitHub(githubToken);

      // Get ticket
      const ticket = getTicket(parseInt(id));

      if (!ticket) {
        console.error(`Ticket #${id} not found`);
        process.exit(1);
      }

      if (ticket.status === 'published') {
        console.log(`⚠️  Ticket #${id} already published: ${ticket.github_issue_url}`);
        return;
      }

      console.log(`Publishing ticket #${id} to GitHub...`);

      // Format issue
      const formatted = formatTicketAsIssue(ticket, config.github);

      // Override with CLI options
      const issueData = {
        owner: config.github.owner,
        repo: config.github.repo,
        title: options.title || formatted.title,
        body: formatted.body,
        labels: options.labels ? options.labels.split(',').map(l => l.trim()) : formatted.labels,
        assignees: options.assignee ? [options.assignee] : []
      };

      // Create GitHub issue
      const issue = await createIssue(issueData);

      console.log(`✓ Created GitHub issue #${issue.number}`);
      console.log(`  ${issue.html_url}`);

      // Update ticket in DB
      updateTicket(parseInt(id), {
        status: 'published',
        github_issue_number: issue.number,
        github_issue_url: issue.html_url,
        github_synced_at: new Date().toISOString(),
        github_status: 'open',
        reviewed_at: new Date().toISOString()
      });

      console.log(`✓ Ticket #${id} marked as published`);

    } catch (error) {
      console.error('Error publishing ticket:', error.message);
      process.exit(1);
    }
  });
