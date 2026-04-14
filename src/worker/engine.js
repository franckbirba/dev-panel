// src/worker/engine.js
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYAML } from 'yaml';
import { predicates } from './predicates.js';
import {
  loadInstance, createInstance, updateInstance, loadInstanceById
} from '../server/workflow-instances.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKFLOW_DIR = join(__dirname, 'workflows');

export function loadWorkflows(dir = DEFAULT_WORKFLOW_DIR) {
  const files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const flows = {};
  const usedPredicates = new Set();

  for (const f of files) {
    const raw = readFileSync(join(dir, f), 'utf8');
    let doc;
    try { doc = parseYAML(raw); }
    catch (e) { throw new Error(`workflow ${f}: YAML parse failed: ${e.message}`); }
    if (!doc?.name) throw new Error(`workflow ${f} missing name`);
    if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
      throw new Error(`workflow ${doc.name} has no steps`);
    }
    doc.on_exhaustion = doc.on_exhaustion || 'block';
    // Collect predicate references and validate they resolve.
    for (const step of doc.steps) {
      for (const branch of Object.values(step.on || {})) {
        if (branch?.when) usedPredicates.add(branch.when);
      }
    }
    if (flows[doc.name]) {
      throw new Error(`duplicate workflow name: ${doc.name} (in ${f})`);
    }
    flows[doc.name] = doc;
  }

  for (const flow of Object.values(flows)) {
    const declared = new Set(flow.steps.map(s => s.agent));
    for (const step of flow.steps) {
      for (const [status, branch] of Object.entries(step.on || {})) {
        if (!branch) continue;
        if (branch.terminal) continue;
        if (branch.workflow) continue; // cross-workflow jump (e.g. replan)
        if (!branch.next) {
          throw new Error(
            `workflow ${flow.name}/${step.agent}/${status}: branch has no action ` +
            `(needs one of terminal, next, workflow)`
          );
        }
        if (!declared.has(branch.next)) {
          throw new Error(
            `workflow ${flow.name}/${step.agent}/${status}: ` +
            `next:${branch.next} is not a declared step agent in this workflow`
          );
        }
      }
    }
  }

  for (const name of usedPredicates) {
    if (typeof predicates[name] !== 'function') {
      throw new Error(`unknown predicate: ${name}`);
    }
  }
  return flows;
}

function findStep(flow, agent) {
  return flow.steps.find(s => s.agent === agent);
}

function pickBranch(step, status, result) {
  const branch = step.on?.[status];
  if (!branch) return null;
  if (branch.when) {
    const pred = predicates[branch.when];
    if (!pred || !pred(result)) return null;
  }
  return branch;
}

function applyRetreat(branch, step, result) {
  const hint = result?.handoff?.next_agent;
  if (!hint || !step.retreat_allowed) return { branch, override: null };
  if (step.retreat_allowed.includes(hint)) {
    return { branch: { ...branch, next: hint, _retreat: true }, override: hint };
  }
  return { branch, override: 'rejected' };
}

/**
 * Pure entry point for the workflow engine.
 * @param {object}   args
 * @param {object}   args.jobData   The BullMQ job payload that just finished.
 * @param {object}   args.result    Parsed agent output JSON.
 * @param {object}   args.flows     Workflow dictionary from loadWorkflows().
 * @param {function} args.enqueue   async (payload, opts?) => ({ id })
 * @param {function} [args.emit]    Optional SSE emitter: (event, data) => void.
 */
export async function triggerNext({ jobData, result, flows, enqueue, emit = () => {} }) {
  if (!jobData?.workflow) {
    // One-off job (deploy, ad-hoc). Engine is a no-op.
    return { action: 'no-workflow' };
  }
  const flow = flows[jobData.workflow];
  if (!flow) {
    throw new Error(`workflow not found: ${jobData.workflow}`);
  }
  const workItemId = jobData.plane?.work_item_id;
  if (!workItemId) throw new Error('triggerNext: missing plane.work_item_id');

  const instance = loadInstance({
    work_item_id: workItemId,
    workflow_name: flow.name
  });
  if (!instance) {
    throw new Error(`no workflow_instance for (${workItemId}, ${flow.name})`);
  }

  const step = findStep(flow, jobData.agent);
  if (!step) {
    updateInstance({ work_item_id: workItemId, workflow_name: flow.name },
                   { status: 'failed', last_job_id: jobData.job_id });
    throw new Error(`no step for agent ${jobData.agent} in workflow ${flow.name}`);
  }

  let branch = pickBranch(step, result.status, result);
  if (!branch) {
    updateInstance({ work_item_id: workItemId, workflow_name: flow.name },
                   { status: result.status || 'failed', last_job_id: jobData.job_id });
    emit('workflow.finished', {
      instance_id: instance.id, status: result.status || 'failed'
    });
    // Replan resume hook fires even on terminal-no-branch paths (e.g. replan pm.done).
    await maybeResumeParent(instance, flow, result, flows, enqueue, emit);
    return { action: 'terminal', reason: 'no-matching-branch' };
  }

  const { branch: effective } = applyRetreat(branch, step, result);

  // Terminal branch
  if (effective.terminal) {
    updateInstance({ work_item_id: workItemId, workflow_name: flow.name },
                   { status: result.status, last_job_id: jobData.job_id });
    emit('workflow.finished', { instance_id: instance.id, status: result.status });
    await maybeResumeParent(instance, flow, result, flows, enqueue, emit);
    return { action: 'terminal' };
  }

  // Replan branch (child workflow)
  if (effective.workflow === 'replan') {
    const currentRev = jobData.workflow_revision ?? instance.revision;
    if (currentRev >= flow.max_revisions) {
      return applyExhaustion(instance, flow, emit);
    }
    updateInstance({ work_item_id: workItemId, workflow_name: flow.name },
                   { status: 'awaiting_approval', last_job_id: jobData.job_id });

    createInstance({
      work_item_id: workItemId,
      workflow_name: 'replan',
      current_step: 'pm',
      module_id: instance.module_id,
      cycle_id: instance.cycle_id,
      metadata: {
        parent_workflow: flow.name,
        parent_revision: instance.revision,
        parent_instance_id: instance.id,
        failed_step: jobData.agent
      }
    });

    await enqueue({
      agent: 'pm',
      workflow: 'replan',
      plane: jobData.plane,
      work_item: jobData.work_item,
      context: jobData.context,
      parent_workflow: flow.name,
      parent_revision: instance.revision,
      parent_instance_id: instance.id,
      failed_step: jobData.agent,
      issues_found: result.issues_found || [],
      blockers: result.blockers || []
    });
    emit('workflow.transitioned', {
      instance_id: instance.id, from_agent: jobData.agent, to_agent: 'pm', reason: 'replan'
    });
    return { action: 'replan' };
  }

  // Forward (or retreat) transition within the same workflow
  if (effective.next) {
    const currentRev = jobData.workflow_revision ?? instance.revision;
    if (currentRev > flow.max_revisions) {
      return applyExhaustion(instance, flow, emit);
    }
    await enqueue({
      agent: effective.next,
      workflow: flow.name,
      workflow_instance_id: instance.id,
      workflow_revision: currentRev,
      plane: jobData.plane,
      work_item: jobData.work_item,
      context: jobData.context
    });
    updateInstance({ work_item_id: workItemId, workflow_name: flow.name },
                   { current_step: effective.next, last_job_id: jobData.job_id });
    emit('workflow.transitioned', {
      instance_id: instance.id,
      from_agent: jobData.agent, to_agent: effective.next,
      reason: effective._retreat ? 'retreat' : 'forward'
    });
    return { action: 'next', agent: effective.next };
  }

  throw new Error(`branch for ${flow.name}/${jobData.agent}/${result.status} has no action`);
}

function applyExhaustion(instance, flow, emit) {
  if (flow.on_exhaustion === 'block' || flow.on_exhaustion === 'escalate') {
    updateInstance(
      { work_item_id: instance.work_item_id, workflow_name: flow.name },
      { status: 'exhausted' }
    );
    emit('workflow.finished', { instance_id: instance.id, status: 'exhausted' });
    return { action: 'exhausted' };
  }
  // 'continue' — rare; log and keep going is not needed for any shipped flow.
  return { action: 'exhausted-continue' };
}

async function maybeResumeParent(instance, flow, result, flows, enqueue, emit) {
  if (flow.name !== 'replan') return;
  let meta;
  try { meta = instance.metadata ? JSON.parse(instance.metadata) : null; }
  catch { meta = null; }
  if (!meta) return;

  let parent = null;
  if (meta.parent_instance_id) {
    parent = loadInstanceById(meta.parent_instance_id);
  }
  if (!parent && meta.parent_workflow) {
    parent = loadInstance({
      work_item_id: instance.work_item_id,
      workflow_name: meta.parent_workflow
    });
  }
  if (!parent) return;
  const parentFlow = flows[parent.workflow_name];
  if (!parentFlow) return;

  if (result.status === 'done') {
    const firstAgent = parentFlow.steps[0].agent;
    const newRev = parent.revision + 1;
    if (newRev > parentFlow.max_revisions) {
      return applyExhaustion(parent, parentFlow, emit);
    }
    await enqueue({
      agent: firstAgent,
      workflow: parent.workflow_name,
      workflow_instance_id: parent.id,
      workflow_revision: newRev,
      plane: { work_item_id: parent.work_item_id,
               module_id: parent.module_id,
               cycle_id: parent.cycle_id }
    });
    updateInstance(
      { work_item_id: parent.work_item_id, workflow_name: parent.workflow_name },
      { status: 'running', revision: newRev, current_step: firstAgent }
    );
    emit('workflow.transitioned', {
      instance_id: parent.id, from_agent: 'pm', to_agent: firstAgent,
      reason: 'replan-resume'
    });
  } else {
    // replan blocked/failed → parent stays awaiting_approval; leave for human.
    emit('workflow.finished', {
      instance_id: parent.id, status: 'awaiting_approval', reason: 'replan-failed'
    });
  }
}
