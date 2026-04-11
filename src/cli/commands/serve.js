import { Command } from 'commander';

export const serveCommand = new Command('serve')
  .description('Start DevPanel API server')
  .option('-p, --port <port>', 'Port to run server on', '3030')
  .option('-H, --host <host>', 'Host to bind to', 'localhost')
  .option('-s, --storage <path>', 'Storage path', './storage')
  .action(async (options) => {
    try {
      const { startServer } = await import('../../server/index.js');
      startServer(options.storage, parseInt(options.port), options.host);
    } catch (error) {
      console.error('Error starting server:', error.message);
      process.exit(1);
    }
  });
