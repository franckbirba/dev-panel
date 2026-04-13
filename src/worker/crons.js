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
