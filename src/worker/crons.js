// src/worker/crons.js
import { getQueue, QUEUES, PRIORITY_MAP } from '../server/bullmq.js';

const CRON_JOBS = [
  {
    name: 'pm:daily-sync',
    data: {
      agent: 'pm',
      task: { id: 'CRON-SYNC', title: 'Daily sync Plane → GitHub → DevPanel' },
      skills: ['shelly-sync'],
      source: 'cron',
      requested_by: 'cron'
    },
    repeat: { pattern: '0 7 * * *' },
    priority: PRIORITY_MAP.p2
  },
  {
    name: 'pm:sprint-plan',
    data: {
      agent: 'pm',
      task: { id: 'CRON-SPRINT', title: 'Weekly sprint planning' },
      skills: ['agent-pm'],
      source: 'cron',
      requested_by: 'cron'
    },
    repeat: { pattern: '0 8 * * 1' },
    priority: PRIORITY_MAP.p2
  },
  {
    name: 'deploy:nightly',
    data: {
      agent: 'deploy',
      job_id: 'deploy-cron',
      requested_by: 'cron:nightly',
      source: 'cron'
    },
    repeat: {
      pattern: process.env.DEPLOY_CRON || '0 3 * * *',
      tz: process.env.DEPLOY_TIMEZONE || 'Europe/Paris'
    },
    priority: PRIORITY_MAP.p1
  },
  {
    // Morning digest — runs as a "shelly:digest" handler in the worker
    // (not a claude -p), assembles the same payload as /api/today and
    // pushes it to Telegram via notifyJob. Cheap, deterministic, no
    // tokens consumed.
    name: 'shelly:morning-digest',
    data: { agent: 'shelly_digest', source: 'cron', requested_by: 'cron:morning' },
    repeat: {
      pattern: process.env.MORNING_DIGEST_CRON || '0 7 * * *',
      tz: process.env.DEPLOY_TIMEZONE || 'Europe/Paris'
    },
    priority: PRIORITY_MAP.p2
  }
];

/**
 * Register all repeatable jobs. BullMQ deduplicates automatically.
 */
export async function registerCrons() {
  const queue = getQueue(QUEUES.agents);

  for (const cron of CRON_JOBS) {
    await queue.add(cron.name, cron.data, {
      repeat: cron.repeat,
      priority: cron.priority
    });
    console.log(`[Crons] Registered ${cron.name} (${cron.repeat.pattern})`);
  }
}
