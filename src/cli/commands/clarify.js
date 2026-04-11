import { Command } from 'commander';
import { readFileSync } from 'fs';
import {
  initMasterDatabase,
  getProjectByName,
  listProjects,
  initProjectDatabase,
  listPendingClarifications,
  answerClarification
} from '../../server/db.js';

const clarifyCommand = new Command('clarify')
  .description('View and answer agent clarification questions');

// List pending clarifications
clarifyCommand
  .command('list')
  .description('List pending clarification questions')
  .option('-p, --project <name>', 'Filter by project')
  .option('-s, --storage <path>', 'Storage path', './storage')
  .action(async (options) => {
    try {
      initMasterDatabase(options.storage);

      let projects;
      if (options.project) {
        const p = getProjectByName(options.project);
        if (!p) {
          console.error(`❌ Project "${options.project}" not found.`);
          process.exit(1);
        }
        projects = [p];
      } else {
        projects = listProjects();
      }

      let total = 0;
      for (const project of projects) {
        initProjectDatabase(options.storage, project.id);
        const pending = listPendingClarifications(options.storage, project.id);

        if (pending.length === 0) continue;

        console.log(`\n📋 ${project.name} — ${pending.length} pending question(s)\n`);

        pending.forEach((c, i) => {
          console.log(`  #${c.ticket_id} [${c.ticket_type}] ${c.ticket_title}`);
          console.log(`  ❓ ${c.question}`);
          console.log(`  📅 Asked: ${new Date(c.asked_at).toLocaleString()}`);
          console.log('');
        });

        total += pending.length;
      }

      if (total === 0) {
        console.log('\n✅ No pending clarifications.\n');
      } else {
        console.log(`Total: ${total} pending question(s)\n`);
        console.log('Use: dev-panel clarify answer <project> <ticket-id> "<answer>"');
      }

    } catch (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  });

// Answer a clarification
clarifyCommand
  .command('answer <project> <ticket-id> <answer>')
  .description('Answer a clarification question')
  .option('-s, --storage <path>', 'Storage path', './storage')
  .option('-i, --index <n>', 'Question index (if multiple questions)', '0')
  .action(async (projectName, ticketId, answer, options) => {
    try {
      initMasterDatabase(options.storage);

      const project = getProjectByName(projectName);
      if (!project) {
        console.error(`❌ Project "${projectName}" not found.`);
        process.exit(1);
      }

      initProjectDatabase(options.storage, project.id);

      const result = answerClarification(
        options.storage,
        project.id,
        parseInt(ticketId),
        parseInt(options.index),
        answer
      );

      if (!result) {
        console.error('❌ Clarification not found.');
        process.exit(1);
      }

      console.log(`\n✅ Answered clarification on ticket #${ticketId}`);
      console.log(`  ❓ ${result.question}`);
      console.log(`  💬 ${result.answer}\n`);

    } catch (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  });

export { clarifyCommand };
