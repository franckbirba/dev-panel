// src/cli/commands/studio.js
// Admin CLI for managing studio_members. This is the operator's only
// editing surface today (per spec: bind to Plane membership later if it
// churns). Run on the services VPS where the master Postgres lives.
//
// Examples:
//   dev-panel studio set --tg-id 5663177530 --name Franck --bot franck \
//     --projects DEVPA,ZENO,EDMS --roles founder,tech-lead \
//     --can-deploy --can-approve-merge
//   dev-panel studio list
//   dev-panel studio remove --tg-id 5663177530

import { Command } from 'commander';

async function loadModule() {
  // Lazy import so the CLI can boot in environments where pg env isn't
  // configured (e.g. running --help on a fresh checkout).
  return import('../../server/studio-members.js');
}

function parseList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function formatRow(m) {
  const flags = [
    m.can_deploy ? 'deploy' : null,
    m.can_approve_merge ? 'merge' : null,
  ].filter(Boolean).join(', ') || '—';
  const projects = m.projects?.length ? m.projects.join(',') : '—';
  return [
    m.display_name.padEnd(20),
    String(m.tg_user_id).padEnd(13),
    (m.bot_label || '—').padEnd(10),
    projects.padEnd(20),
    flags,
  ].join('  ');
}

const studioCommand = new Command('studio')
  .description('Manage studio members (Telegram identity + capability + destination)');

studioCommand
  .command('set')
  .description('Insert or update a studio member')
  .requiredOption('--tg-id <id>', 'Telegram user ID (numeric)')
  .requiredOption('--name <name>', 'Display name')
  .option('--bot <label>', 'Paired bot label (matches dev_bots.bot_label)')
  .option('--projects <list>', 'Comma-separated project slugs (e.g. DEVPA,ZENO)')
  .option('--roles <list>', 'Comma-separated role labels')
  .option('--can-deploy', 'Grant deploy capability', false)
  .option('--can-approve-merge', 'Grant merge-approval capability', false)
  .option('--chat-id <id>', 'Default DM chat ID (defaults to --tg-id)')
  .action(async (opts) => {
    try {
      const sm = await loadModule();
      const row = await sm.upsertMember({
        tg_user_id: BigInt(opts.tgId),
        display_name: opts.name,
        bot_label: opts.bot || null,
        projects: parseList(opts.projects),
        roles: parseList(opts.roles),
        can_deploy: Boolean(opts.canDeploy),
        can_approve_merge: Boolean(opts.canApproveMerge),
        default_dm_chat_id: opts.chatId ? BigInt(opts.chatId) : BigInt(opts.tgId),
      });
      console.log(`✓ studio member set: ${row.display_name} (tg=${row.tg_user_id})`);
      console.log(formatRow(row));
    } catch (err) {
      console.error(`✗ studio set failed: ${err.message}`);
      process.exit(1);
    }
  });

studioCommand
  .command('list')
  .description('List all studio members')
  .action(async () => {
    try {
      const sm = await loadModule();
      const rows = await sm.listMembers();
      if (rows.length === 0) {
        console.log('(no studio members yet — use `dev-panel studio set` to add one)');
        return;
      }
      const header = [
        'NAME'.padEnd(20),
        'TG_ID'.padEnd(13),
        'BOT'.padEnd(10),
        'PROJECTS'.padEnd(20),
        'CAPS',
      ].join('  ');
      console.log(header);
      console.log('-'.repeat(header.length));
      for (const r of rows) console.log(formatRow(r));
    } catch (err) {
      console.error(`✗ studio list failed: ${err.message}`);
      process.exit(1);
    }
  });

studioCommand
  .command('remove')
  .description('Delete a studio member by Telegram user ID')
  .requiredOption('--tg-id <id>', 'Telegram user ID (numeric)')
  .action(async (opts) => {
    try {
      const sm = await loadModule();
      const removed = await sm.removeMember(BigInt(opts.tgId));
      if (removed) {
        console.log(`✓ studio member removed: tg=${opts.tgId}`);
      } else {
        console.log(`(no member with tg=${opts.tgId})`);
      }
    } catch (err) {
      console.error(`✗ studio remove failed: ${err.message}`);
      process.exit(1);
    }
  });

studioCommand
  .command('check')
  .description('Check whether a Telegram user has a capability')
  .requiredOption('--tg-id <id>', 'Telegram user ID')
  .requiredOption('--cap <capability>', 'Capability: deploy | approve_merge')
  .action(async (opts) => {
    try {
      const sm = await loadModule();
      const ok = await sm.isAuthorized(BigInt(opts.tgId), opts.cap);
      console.log(ok ? `✓ authorized (${opts.cap})` : `✗ not authorized (${opts.cap})`);
      process.exit(ok ? 0 : 1);
    } catch (err) {
      console.error(`✗ studio check failed: ${err.message}`);
      process.exit(1);
    }
  });

export { studioCommand };
