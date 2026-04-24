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
    // Workflow ops hit the master SQLite (workflow_instances); initialize
    // it the same way the worker + server do.
    const { initMasterDatabase } = await import('../src/server/db.js');
    initMasterDatabase(process.env.DEVPANEL_STORAGE || './storage');

    if (action === 'dispatch') {
      if (!work_item_id) { console.error('work_item_id is required'); process.exit(2); }
      const { enqueueWorkflowStart } = await import('../src/worker/dispatch.js');

      // Best-effort: fetch the work item title/description from Plane so the
      // agent gets real context even when plane-mcp can't deserialise the
      // response. Bypasses the MCP-level pydantic bug seen on 2026-04-16.
      let work_item = {};
      const base = (process.env.PLANE_BASE_URL || '').replace(/\/$/, '');
      const slug = process.env.PLANE_WORKSPACE_SLUG;
      const key  = process.env.PLANE_API_KEY;
      const pid  = process.env.PLANE_PROJECT_ID;
      if (base && slug && key && pid) {
        try {
          const res = await fetch(
            `${base}/api/v1/workspaces/${slug}/projects/${pid}/issues/${work_item_id}/`,
            { headers: { 'X-API-Key': key } }
          );
          if (res.ok) {
            const i = await res.json();
            const desc = (i.description_html || '')
              .replace(/<\/?(p|div|h[1-6]|li|br)[^>]*>/gi, '\n')
              .replace(/<li[^>]*>/gi, '- ')
              .replace(/<[^>]+>/g, '')
              .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/\n{3,}/g, '\n\n').trim();
            work_item = {
              sequence_id: i.sequence_id,
              title: i.name,
              name: i.name,
              description: desc,
              priority: i.priority
            };
          } else {
            console.warn(`plane lookup ${res.status} — dispatching without work_item context`);
          }
        } catch (err) {
          console.warn(`plane lookup failed: ${err.message} — continuing without work_item context`);
        }
      }

      let out;
      try {
        out = await enqueueWorkflowStart({
          workflow: opts.workflow,
          plane: { work_item_id, module_id: opts.module, cycle_id: opts.cycle },
          work_item
        });
      } catch (err) {
        console.error(`dispatch failed: ${err.message}`);
        process.exit(1);
      }
      console.log(JSON.stringify(out, null, 2));
      process.exit(out.ok ? 0 : 1);
    }
    if (action === 'list') {
      const { listActive } = await import('../src/server/workflow-instances.js');
      console.table(await listActive());
      return;
    }
    console.error(`unknown action: ${action}`);
    process.exit(2);
  });

program.parse();
