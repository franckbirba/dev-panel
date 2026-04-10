import { Command } from 'commander';
import { join } from 'path';

export const serveCommand = new Command('serve')
  .description('Start DevPanel API server')
  .option('-p, --port <port>', 'Port to run server on')
  .option('-d, --daemon', 'Run server in background')
  .action(async (options) => {
    const cwd = process.cwd();
    const configPath = join(cwd, '.devpanelrc.json');

    if (options.daemon) {
      console.log('⚠️  Daemon mode not implemented yet. Run without --daemon flag.');
      process.exit(1);
    }

    try {
      const { startServer } = await import('../../server/index.js');
      startServer(configPath);
    } catch (error) {
      console.error('Error starting server:', error.message);
      process.exit(1);
    }
  });
