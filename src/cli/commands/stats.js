import { Command } from 'commander';
import { join } from 'path';
import { readFileSync } from 'fs';

export const statsCommand = new Command('stats')
  .description('Show ticket statistics')
  .option('-p, --project <project>', 'Filter by project')
  .action(async (options) => {
    const cwd = process.cwd();
    const configPath = join(cwd, '.devpanelrc.json');

    try {
      // Load config
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));

      // Initialize DB
      const { initDatabase, getStats } = await import('../../server/db.js');
      initDatabase(config.storage.path);

      // Get stats
      const stats = getStats(options.project || config.project);

      console.log('\n📊 DevPanel Statistics\n');
      console.log(`Project: ${options.project || config.project}`);
      console.log('─'.repeat(40));
      console.log(`Pending:    ${stats.pending.toString().padStart(4)}`);
      console.log(`Published:  ${stats.published.toString().padStart(4)}`);
      console.log(`Closed:     ${stats.closed.toString().padStart(4)}`);
      console.log(`Rejected:   ${stats.rejected.toString().padStart(4)}`);
      console.log('─'.repeat(40));
      console.log(`Total:      ${stats.total.toString().padStart(4)}`);
      console.log('');

    } catch (error) {
      console.error('Error getting stats:', error.message);
      process.exit(1);
    }
  });
