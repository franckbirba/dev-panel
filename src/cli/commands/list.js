import { Command } from 'commander';
import { join } from 'path';
import { readFileSync } from 'fs';

function formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function formatTable(tickets) {
  if (tickets.length === 0) {
    console.log('No tickets found.');
    return;
  }

  console.log('┌────┬──────────┬─────────────────────────────────────┬───────────┬────────────┐');
  console.log('│ ID │ Type     │ Title                               │ Status    │ Created    │');
  console.log('├────┼──────────┼─────────────────────────────────────┼───────────┼────────────┤');

  tickets.forEach(ticket => {
    const id = String(ticket.id).padEnd(2);
    const type = ticket.type.padEnd(8);
    const title = (ticket.title.length > 35 ? ticket.title.substring(0, 32) + '...' : ticket.title).padEnd(35);
    const status = ticket.status.padEnd(9);
    const created = formatDate(ticket.created_at).padEnd(10);

    console.log(`│ ${id} │ ${type} │ ${title} │ ${status} │ ${created} │`);
  });

  console.log('└────┴──────────┴─────────────────────────────────────┴───────────┴────────────┘');
}

export const listCommand = new Command('list')
  .description('List tickets')
  .option('-s, --status <status>', 'Filter by status (pending, published, rejected, closed)')
  .option('-p, --project <project>', 'Filter by project')
  .option('-l, --limit <limit>', 'Limit number of results', '50')
  .action(async (options) => {
    const cwd = process.cwd();
    const configPath = join(cwd, '.devpanelrc.json');

    try {
      // Load config
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));

      // Initialize DB
      const { initDatabase, listTickets } = await import('../../server/db.js');
      initDatabase(config.storage.path);

      // Get tickets
      const tickets = listTickets({
        status: options.status,
        project: options.project || config.project,
        limit: parseInt(options.limit)
      });

      formatTable(tickets);

      // Summary
      console.log(`\nTotal: ${tickets.length} tickets`);

    } catch (error) {
      console.error('Error listing tickets:', error.message);
      process.exit(1);
    }
  });
