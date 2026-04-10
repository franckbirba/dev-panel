import { Command } from 'commander';
import { join } from 'path';
import { readFileSync } from 'fs';

export const rejectCommand = new Command('reject')
  .description('Reject a ticket')
  .argument('<id>', 'Ticket ID to reject')
  .option('-r, --reason <reason>', 'Rejection reason', 'Not applicable')
  .action(async (id, options) => {
    const cwd = process.cwd();
    const configPath = join(cwd, '.devpanelrc.json');

    try {
      // Load config
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));

      // Initialize DB
      const { initDatabase, getTicket, updateTicket } = await import('../../server/db.js');
      initDatabase(config.storage.path);

      // Get ticket
      const ticket = getTicket(parseInt(id));

      if (!ticket) {
        console.error(`Ticket #${id} not found`);
        process.exit(1);
      }

      if (ticket.status === 'rejected') {
        console.log(`⚠️  Ticket #${id} already rejected`);
        return;
      }

      // Update ticket
      updateTicket(parseInt(id), {
        status: 'rejected',
        rejection_reason: options.reason,
        reviewed_at: new Date().toISOString()
      });

      console.log(`✓ Ticket #${id} rejected`);
      console.log(`  Reason: ${options.reason}`);

    } catch (error) {
      console.error('Error rejecting ticket:', error.message);
      process.exit(1);
    }
  });
