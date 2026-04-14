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
import { adminCommand } from '../src/cli/commands/admin.js';
import { initCommand } from '../src/cli/commands/init.js';
import { serveCommand } from '../src/cli/commands/serve.js';
import { listCommand } from '../src/cli/commands/list.js';
import { reviewCommand } from '../src/cli/commands/review.js';
import { publishCommand } from '../src/cli/commands/publish.js';
import { rejectCommand } from '../src/cli/commands/reject.js';
import { syncCommand } from '../src/cli/commands/sync.js';
import { statsCommand } from '../src/cli/commands/stats.js';
import { importCommand } from '../src/cli/commands/import.js';
import { syncDocsCommand } from '../src/cli/commands/sync-docs.js';
import { clarifyCommand } from '../src/cli/commands/clarify.js';

// Register commands
program.addCommand(adminCommand);
program.addCommand(initCommand);
program.addCommand(serveCommand);
program.addCommand(listCommand);
program.addCommand(reviewCommand);
program.addCommand(publishCommand);
program.addCommand(rejectCommand);
program.addCommand(syncCommand);
program.addCommand(statsCommand);
program.addCommand(importCommand);
program.addCommand(syncDocsCommand);
program.addCommand(clarifyCommand);

program
  .command('workflow')
  .argument('<action>', 'dispatch | list')
  .argument('[work_item_id]')
  .option('--workflow <name>', 'work-item | cycle-audit', 'work-item')
  .option('--module <id>')
  .option('--cycle <id>')
  .description('Workflow engine operations')
  .action(async (action, work_item_id, opts) => {
    if (action === 'dispatch') {
      if (!work_item_id) { console.error('work_item_id is required'); process.exit(2); }
      const { enqueueWorkflowStart } = await import('../src/worker/dispatch.js');
      const out = await enqueueWorkflowStart({
        workflow: opts.workflow,
        plane: { work_item_id, module_id: opts.module, cycle_id: opts.cycle }
      });
      console.log(JSON.stringify(out, null, 2));
      process.exit(out.ok ? 0 : 1);
    }
    if (action === 'list') {
      const { listActive } = await import('../src/server/workflow-instances.js');
      console.table(listActive());
      return;
    }
    console.error(`unknown action: ${action}`);
    process.exit(2);
  });

program.parse();
