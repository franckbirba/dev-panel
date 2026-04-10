import { Command } from 'commander';
import { join } from 'path';
import { readFileSync } from 'fs';

export const syncCommand = new Command('sync')
  .description('Sync tickets with GitHub issues')
  .option('-a, --auto', 'Auto-sync all published tickets')
  .action(async (options) => {
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
      const { initDatabase, listTickets, updateTicket } = await import('../../server/db.js');
      const { initGitHub, getIssue } = await import('../../server/github.js');

      initDatabase(config.storage.path);
      initGitHub(githubToken);

      // Get all published tickets
      const publishedTickets = listTickets({
        status: 'published',
        project: config.project,
        limit: 1000
      });

      console.log(`Syncing ${publishedTickets.length} published tickets...`);

      let synced = 0;
      let closed = 0;

      for (const ticket of publishedTickets) {
        if (!ticket.github_issue_number) {
          console.log(`⚠️  Ticket #${ticket.id} has no GitHub issue number`);
          continue;
        }

        try {
          const issue = await getIssue({
            owner: config.github.owner,
            repo: config.github.repo,
            issue_number: ticket.github_issue_number
          });

          const updates = {
            github_status: issue.state,
            github_synced_at: new Date().toISOString()
          };

          // If issue is closed, mark ticket as closed
          if (issue.state === 'closed' && ticket.status === 'published') {
            updates.status = 'closed';
            closed++;
          }

          updateTicket(ticket.id, updates);
          synced++;

          console.log(`✓ Synced ticket #${ticket.id} (GitHub #${ticket.github_issue_number}) - ${issue.state}`);

        } catch (error) {
          console.log(`⚠️  Failed to sync ticket #${ticket.id}: ${error.message}`);
        }
      }

      console.log(`\nSync complete: ${synced} tickets synced, ${closed} closed`);

    } catch (error) {
      console.error('Error syncing tickets:', error.message);
      process.exit(1);
    }
  });
