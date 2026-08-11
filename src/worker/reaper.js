// src/worker/reaper.js
//
// Instance reaper — réconcilie les workflow_instances fantômes.
//
// Un fantôme = une instance status='running' dont le job BullMQ est mort
// (crash driver, OOM, restart du worker) sans transition d'état. BullMQ
// émet bien `stalled`, mais rien ne réconciliait la ligne Postgres : la
// fleet affichait des dizaines de "running" morts (audit 2026-08-11).
//
// Politique : une instance est candidate quand last_event_at est plus
// vieux que le TTL de son étape courante. Avant de tuer, cross-check
// BullMQ : un job encore active/waiting/delayed n'est JAMAIS reapé
// (long build légitime). Chaque reap écrit un audit_finding en mémoire
// pour l'analyse des causes racines.
//
// Env:
//   REAPER_ENABLED           "true"/"false"  défaut "true"
//   REAPER_INTERVAL_MS       défaut 300000 (5 min)
//   REAPER_TTL_BUILDER_MS    défaut 5400000 (90 min)
//   REAPER_DEFAULT_TTL_MS    défaut 3600000 (60 min)

import { listRunningInstances, updateInstance } from '../server/workflow-instances.js';
import { getQueue, QUEUES } from '../server/bullmq.js';
import { memoryInsert } from '../server/pg.js';
import { embed } from '../server/voyage.js';

const ENABLED = (process.env.REAPER_ENABLED ?? 'true') === 'true';
const INTERVAL_MS = parseInt(process.env.REAPER_INTERVAL_MS || '300000', 10);
const DEFAULT_TTL_MS = parseInt(process.env.REAPER_DEFAULT_TTL_MS || String(60 * 60 * 1000), 10);

const TTL_BY_STEP = {
  builder: parseInt(process.env.REAPER_TTL_BUILDER_MS || String(90 * 60 * 1000), 10),
  reviewer: 30 * 60 * 1000,
  qa: 30 * 60 * 1000,
  pm: 30 * 60 * 1000,
  'merge-coordinator': 20 * 60 * 1000
};

export function ttlForStep(step) {
  return TTL_BY_STEP[step] ?? DEFAULT_TTL_MS;
}

export function isStale(instance, now = Date.now()) {
  return now - Number(instance.last_event_at) > ttlForStep(instance.current_step);
}

// États BullMQ considérés vivants — on ne touche pas.
const LIVE_STATES = new Set(['active', 'waiting', 'delayed']);

async function bullJobState(jobId) {
  if (!jobId) return 'missing';
  try {
    const job = await getQueue(QUEUES.agents).getJob(String(jobId));
    return job ? await job.getState() : 'missing';
  } catch {
    return 'unknown';
  }
}

async function writeAuditFinding(inst, jobState, now) {
  // Best-effort : un échec mémoire ne doit jamais bloquer la réconciliation.
  try {
    const title = `Reaped ghost: ${inst.workflow_name}/${inst.current_step} (wi ${String(inst.work_item_id).slice(0, 8)})`;
    const content = [
      `Instance ${inst.id} reapée le ${new Date(now).toISOString()}.`,
      `step=${inst.current_step} last_job_id=${inst.last_job_id} bull_state=${jobState}`,
      `last_event_at=${new Date(Number(inst.last_event_at)).toISOString()} (TTL ${Math.round(ttlForStep(inst.current_step) / 60000)} min dépassé)`
    ].join('\n');
    const embedding = await embed(`${title}\n\n${content}`);
    await memoryInsert({
      namespace: process.env.AGENT_MEMORY_NAMESPACE || 'dev-panel',
      agent: 'reaper', kind: 'audit_finding',
      title, content, tags: ['reaper', inst.current_step || 'unknown'],
      work_item_id: inst.work_item_id, embedding
    });
  } catch (err) {
    console.warn(`[Reaper] audit_finding write failed for instance ${inst.id}:`, err.message);
  }
}

export async function reapTick({ now = Date.now() } = {}) {
  const candidates = await listRunningInstances();
  let reaped = 0, skipped = 0;
  for (const inst of candidates) {
    if (!isStale(inst, now)) { skipped++; continue; }
    const jobState = await bullJobState(inst.last_job_id);
    if (LIVE_STATES.has(jobState)) { skipped++; continue; }

    let meta = {};
    try { meta = inst.metadata ? JSON.parse(inst.metadata) : {}; } catch { meta = {}; }
    await updateInstance(
      { work_item_id: inst.work_item_id, workflow_name: inst.workflow_name },
      {
        status: 'failed',
        metadata: JSON.stringify({
          ...meta,
          reaped: true,
          reap_reason: `ttl_exceeded:${inst.current_step}`,
          reap_bull_state: jobState,
          reaped_at: now
        })
      }
    );
    await writeAuditFinding(inst, jobState, now);
    console.log(`[Reaper] reaped instance ${inst.id} (${inst.workflow_name}/${inst.current_step}, bull=${jobState})`);
    reaped++;
  }
  if (reaped) console.log(`[Reaper] tick done — seen=${candidates.length} reaped=${reaped} skipped=${skipped}`);
  return { seen: candidates.length, reaped, skipped };
}

let _timer = null;

export function startReaper() {
  if (!ENABLED) {
    console.log('[Reaper] disabled via REAPER_ENABLED=false');
    return;
  }
  console.log(`[Reaper] every ${Math.round(INTERVAL_MS / 1000)}s, default TTL ${Math.round(DEFAULT_TTL_MS / 60000)} min`);
  const run = async () => {
    try { await reapTick(); } catch (err) { console.error('[Reaper] tick threw:', err); }
    _timer = setTimeout(run, INTERVAL_MS);
  };
  run();
}

export function stopReaper() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}
