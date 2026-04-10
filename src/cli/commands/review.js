import { Command } from 'commander';
import { join } from 'path';
import { readFileSync } from 'fs';

export const reviewCommand = new Command('review')
  .description('Review a ticket in detail (formatted for Claude Code)')
  .argument('<id>', 'Ticket ID to review')
  .action(async (id) => {
    const cwd = process.cwd();
    const configPath = join(cwd, '.devpanelrc.json');

    try {
      // Load config
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));

      // Initialize DB
      const { initDatabase, getTicket } = await import('../../server/db.js');
      initDatabase(config.storage.path);

      // Get ticket
      const ticket = getTicket(parseInt(id));

      if (!ticket) {
        console.error(`Ticket #${id} not found`);
        process.exit(1);
      }

      // Format for Claude Code
      console.log('='.repeat(80));
      console.log(`TICKET #${ticket.id} - ${ticket.type.toUpperCase()} REPORT`);
      console.log('='.repeat(80));
      console.log(`Status: ${ticket.status}`);
      console.log(`Created: ${new Date(ticket.created_at).toLocaleString()} by ${ticket.created_by || 'unknown'}`);
      console.log(`Project: ${ticket.project || 'unknown'}`);
      console.log('');

      console.log('TITLE:');
      console.log(ticket.title);
      console.log('');

      console.log('DESCRIPTION:');
      console.log(ticket.description);
      console.log('');

      if (ticket.context) {
        console.log('CONTEXT:');
        const ctx = ticket.context;
        if (ctx.url) console.log(`- URL: ${ctx.url}`);
        if (ctx.userAgent) console.log(`- User Agent: ${ctx.userAgent}`);
        if (ctx.timestamp) console.log(`- Timestamp: ${new Date(ctx.timestamp).toISOString()}`);
        if (ctx.viewport) console.log(`- Viewport: ${ctx.viewport.width}x${ctx.viewport.height}`);
        console.log('');
      }

      if (ticket.screenshot_path) {
        console.log('SCREENSHOT:');
        console.log(join(config.storage.path, ticket.screenshot_path));
        console.log('');
      }

      if (ticket.github_issue_url) {
        console.log('GITHUB ISSUE:');
        console.log(ticket.github_issue_url);
        console.log('');
      }

      console.log('='.repeat(80));
      console.log('ACTIONS:');
      console.log(`  dev-panel publish ${ticket.id}        # Convert to GitHub issue`);
      console.log(`  dev-panel reject ${ticket.id}         # Reject this ticket`);
      console.log('='.repeat(80));

    } catch (error) {
      console.error('Error reviewing ticket:', error.message);
      process.exit(1);
    }
  });
