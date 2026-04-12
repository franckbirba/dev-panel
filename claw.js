import TelegramBot from 'node-telegram-bot-api';
import { spawn } from 'child_process';
import { config } from 'dotenv';

config();

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const REPO = process.env.GITHUB_REPO;
const ASSIGNEE = process.env.GITHUB_ASSIGNEE;

// Helper: Execute shell command
function exec(command, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { shell: true });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => stdout += data);
    proc.stderr.on('data', (data) => stderr += data);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout));
    });
  });
}

// Get assigned issues
async function getAssignedIssues() {
  const json = await exec('gh', [
    'issue', 'list',
    '--repo', REPO,
    '--assignee', ASSIGNEE,
    '--json', 'number,title,url',
    '--state', 'open'
  ]);
  return JSON.parse(json);
}

// Resolve issue with claw
async function resolveIssue(issueNumber, chatId) {
  bot.sendMessage(chatId, `🔧 Démarrage de la résolution de l'issue #${issueNumber}...`);
  
  try {
    const cloneDir = `/tmp/dev-panel-${Date.now()}`;
    await exec(`gh repo clone ${REPO} ${cloneDir}`);
    
    const output = await exec('claw', [
      '--repo-path', cloneDir,
      '--issue', issueNumber,
      '--auto-commit',
      '--push'
    ]);
    
    bot.sendMessage(chatId, `✅ Issue #${issueNumber} résolue !\n\n${output.slice(0, 500)}`);
    
    // Cleanup
    await exec(`rm -rf ${cloneDir}`);
  } catch (error) {
    bot.sendMessage(chatId, `❌ Erreur sur issue #${issueNumber}: ${error.message}`);
  }
}

// Commands
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    '👋 Salut ! Je suis Shelly.\n\n' +
    'Commandes:\n' +
    '/issues - Liste les issues assignées\n' +
    '/resolve <number> - Résoudre une issue\n' +
    '/resolveall - Résoudre toutes les issues'
  );
});

bot.onText(/\/issues/, async (msg) => {
  try {
    const issues = await getAssignedIssues();
    if (issues.length === 0) {
      bot.sendMessage(msg.chat.id, '✨ Aucune issue assignée !');
      return;
    }
    
    const list = issues.map(i => `#${i.number}: ${i.title}`).join('\n');
    bot.sendMessage(msg.chat.id, `📋 Issues assignées:\n\n${list}`);
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Erreur: ${error.message}`);
  }
});

bot.onText(/\/resolve (\d+)/, async (msg, match) => {
  const issueNumber = match[1];
  await resolveIssue(issueNumber, msg.chat.id);
});

bot.onText(/\/resolveall/, async (msg) => {
  try {
    const issues = await getAssignedIssues();
    if (issues.length === 0) {
      bot.sendMessage(msg.chat.id, '✨ Aucune issue à résoudre !');
      return;
    }
    
    bot.sendMessage(msg.chat.id, `🚀 Résolution de ${issues.length} issue(s)...`);
    
    for (const issue of issues) {
      await resolveIssue(issue.number, msg.chat.id);
    }
    
    bot.sendMessage(msg.chat.id, '✅ Toutes les issues ont été traitées !');
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Erreur: ${error.message}`);
  }
});

console.log('🤖 Shelly bot started...');