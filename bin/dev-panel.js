#!/usr/bin/env node

import { Command } from 'commander';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, '../package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

const program = new Command();

program
  .name('dev-panel')
  .description('Bug/feature tracking CLI for PM and developers')
  .version(pkg.version);

// Import commands
import { initCommand } from '../src/cli/commands/init.js';
import { serveCommand } from '../src/cli/commands/serve.js';
import { listCommand } from '../src/cli/commands/list.js';
import { reviewCommand } from '../src/cli/commands/review.js';
import { publishCommand } from '../src/cli/commands/publish.js';
import { rejectCommand } from '../src/cli/commands/reject.js';
import { syncCommand } from '../src/cli/commands/sync.js';
import { statsCommand } from '../src/cli/commands/stats.js';

// Register commands
program.addCommand(initCommand);
program.addCommand(serveCommand);
program.addCommand(listCommand);
program.addCommand(reviewCommand);
program.addCommand(publishCommand);
program.addCommand(rejectCommand);
program.addCommand(syncCommand);
program.addCommand(statsCommand);

program.parse();
