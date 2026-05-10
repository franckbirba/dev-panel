// src/worker/engine.js
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYAML } from 'yaml';
import { predicates } from './predicates.js';
import {
  loadInstance, createInstance, updateInstance, loadInstanceById
} from '../server/workflow-instances.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKFLOW_DIR = join(__dirname, 'workflows');

// In-process cache for loaded workflows, keyed by dir. Tracks the newest YAML
// mtime seen at load time and reloads whenever any YAML on disk is newer.
//
// Why: pre-2026-05-09 the worker cached `loadWorkflows()` result for the
// process lifetime. A deploy that updated merge-coordinator.yaml (e.g. PR #67
// adding `next: builder` for conflict bails) was effectively invisible until
// somebody manually `systemctl restart devpanel-worker.service`. PR #17 / #18
// burned ~30h of merge-coordinator → "blocked terminal" loops because of this
// alone. mtime check is one statSync per YAML per call, negligible.
const _cache = new Map(); // dir -> { flows, mtimeMs }

function newestMtime(dir) {
  const files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  let max = 0;
  for (const f of files) {
    const m = statSync(join(dir, f)).mtimeMs;
    if (m > max) max = m;
  }
  return max;
}

/**
 * Cached loadWorkflows(): reuses the parsed flows when no YAML on disk has
 * changed since the last call. Use this from the hot path (dispatch.js,
 * automation.js); call loadWorkflows() directly only if a fresh, never-cached
 * read is required (tests).
 */
export function getCachedWorkflows(dir = DEFAULT_WORKFLOW_DIR) {
  const cached = _cache.get(dir);
  let mtime;
  try { mtime = newestMtime(dir); }
  catch (e) {
    // Workflow dir gone / unreadable. If we have a cached copy fall back to
    // it — better than crashing the engine on a transient FS hiccup.
    if (cached) return cached.flows;
    throw e;
  }
  if (cached && cached.mtimeMs >= mtime) return cached.flows;
  const flows = loadWorkflows(dir);
  _cache.set(dir, { flows, mtimeMs: mtime });
  return flows;
}

// Test seam: clear the cache between cases that fiddle with workflow YAMLs.
export function __resetWorkflowCacheForTests() { _cache.clear(); }

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
  if (!hint || !step.retreat_allowed) return { branch };
  if (step.retreat_allowed.includes(hint)) {
    return { branch: { ...branch, next: hint, _retreat: true } };
  }
  return { branch };
}

/**
 * Wrap a user-supplied emit so SSE failures never poison the evaluator.
 * emit() is best-effort (spec §10): a thrown emit must not corrupt state or
 * cause BullMQ retries (which would re-execute and double-enqueue).
 */
function safeEmit(emit) {
  return (event, data) => {
    try { emit(event, data); }
    catch (e) { console.warn(`[engine] emit failed for ${event}: ${e.message}`); }
  };
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
  const _emit = safeEmit(emit);

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

  const instance = await loadInstance({
    work_item_id: workItemId,
    workflow_name: flow.name
  });
  if (!instance) {
    throw new Error(`no workflow_instance for (${workItemId}, ${flow.name})`);
  }

  const step = findStep(flow, jobData.agent);
  if (!step) {
    await updateInstance({ work_item_id: workItemId, workflow_name: flow.name },
                   { status: 'failed', last_job_id: jobData.job_id });
    throw new Error(`no step for agent ${jobData.agent} in workflow ${flow.name}`);
  }

  let branch = pickBranch(step, result.status, result);
  if (!branch) {
    await updateInstance({ work_item_id: workItemId, workflow_name: flow.name },
                   { status: result.status || 'failed', last_job_id: jobData.job_id });
    _emit('workflow.finished', {
      instance_id: instance.id, status: result.status || 'failed'
    });
    // Replan resume hook fires even on terminal-no-branch paths (e.g. replan pm.done).
    await maybeResumeParent(instance, flow, result, flows, enqueue, _emit);
    return { action: 'terminal', reason: 'no-matching-branch' };
  }

  const { branch: effective } = applyRetreat(branch, step, result);

  // Terminal branch
  if (effective.terminal) {
    await updateInstance({ work_item_id: workItemId, workflow_name: flow.name },
                   { status: result.status, last_job_id: jobData.job_id });
    _emit('workflow.finished', { instance_id: instance.id, status: result.status });
    await maybeResumeParent(instance, flow, result, flows, enqueue, _emit);
    return { action: 'terminal' };
  }

  // Replan branch (child workflow)
  if (effective.workflow === 'replan') {
    const currentRev = jobData.workflow_revision ?? instance.revision;
    if (currentRev >= flow.max_revisions) {
      return applyExhaustion(instance, flow, _emit);
    }

    // Create the child instance FIRST so we have its id for the payload and
    // so a failed enqueue can roll it back cleanly. The parent status update
    // is deferred until after enqueue succeeds.
    const childId = await createInstance({
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

    try {
      // Strip per-spawn fields from forwarded context (see comment on the
      // forward-transition enqueue below for full rationale).
      const { worktree_path: _wtPath, ...replanContext } = jobData.context || {};
      await enqueue({
        agent: 'pm',
        workflow: 'replan',
        workflow_instance_id: childId,
        plane: jobData.plane,
        work_item: jobData.work_item,
        context: replanContext,
        parent_workflow: flow.name,
        parent_revision: instance.revision,
        parent_instance_id: instance.id,
        failed_step: jobData.agent,
        issues_found: result.issues_found || [],
        blockers: result.blockers || []
      });
    } catch (e) {
      // Roll the child row to 'failed' so the unique partial index
      // (which excludes 'failed') lets a future retry create a fresh replan.
      await updateInstance(
        { work_item_id: workItemId, workflow_name: 'replan' },
        { status: 'failed', last_job_id: jobData.job_id }
      );
      throw e;
    }

    await updateInstance({ work_item_id: workItemId, workflow_name: flow.name },
                   { status: 'awaiting_approval', last_job_id: jobData.job_id });
    _emit('workflow.transitioned', {
      instance_id: instance.id, from_agent: jobData.agent, to_agent: 'pm', reason: 'replan'
    });
    return { action: 'replan' };
  }

  // Forward (or retreat) transition within the same workflow
  if (effective.next) {
    const currentRev = jobData.workflow_revision ?? instance.revision;
    if (currentRev >= flow.max_revisions) {
      return applyExhaustion(instance, flow, _emit);
    }
    // Sanitize context before forwarding. Per-spawn fields (worktree_path)
    // belong to the CURRENT job only — the next agent will derive its own
    // worktree in src/worker/index.js. Carrying worktree_path forward was
    // the structural cause of canary 2129 (DEVPA-155, 2026-05-08): the
    // verifier in the next step inherited a path that prepareWorktree had
    // already reclaimed. Workflow-level fields (branch, default_branch,
    // project_root, github_issue_number, devpanel_ticket_id, etc.) propagate.
    const { worktree_path, ...workflow_context } = jobData.context || {};
    await enqueue({
      agent: effective.next,
      workflow: flow.name,
      workflow_instance_id: instance.id,
      workflow_revision: currentRev,
      plane: jobData.plane,
      work_item: jobData.work_item,
      context: workflow_context
    });
    await updateInstance({ work_item_id: workItemId, workflow_name: flow.name },
                   { current_step: effective.next, last_job_id: jobData.job_id });
    _emit('workflow.transitioned', {
      instance_id: instance.id,
      from_agent: jobData.agent, to_agent: effective.next,
      reason: effective._retreat ? 'retreat' : 'forward'
    });
    return { action: 'next', agent: effective.next };
  }

  throw new Error(`branch for ${flow.name}/${jobData.agent}/${result.status} has no action`);
}

async function applyExhaustion(instance, flow, _emit) {
  // 'block' and 'escalate' are handled identically in Spec 2;
  // 'escalate' ships its button UX in a later spec.
  await updateInstance(
    { work_item_id: instance.work_item_id, workflow_name: flow.name },
    { status: 'exhausted' }
  );
  _emit('workflow.finished', { instance_id: instance.id, status: 'exhausted' });
  return { action: 'exhausted' };
}

async function maybeResumeParent(instance, flow, result, flows, enqueue, _emit) {
  if (flow.name !== 'replan') return;
  let meta;
  try { meta = instance.metadata ? JSON.parse(instance.metadata) : null; }
  catch { meta = null; }
  if (!meta?.parent_instance_id) {
    console.warn(
      `[engine] replan instance ${instance.id} missing parent_instance_id — cannot resume`
    );
    return;
  }
  const parent = await loadInstanceById(meta.parent_instance_id);
  if (!parent) {
    console.warn(
      `[engine] replan parent ${meta.parent_instance_id} not found — cannot resume`
    );
    return;
  }
  const parentFlow = flows[parent.workflow_name];
  if (!parentFlow) return;

  if (result.status === 'done') {
    const firstAgent = parentFlow.steps[0].agent;
    const newRev = parent.revision + 1;
    if (newRev > parentFlow.max_revisions) {
      return applyExhaustion(parent, parentFlow, _emit);
    }
    try {
      await enqueue({
        agent: firstAgent,
        workflow: parent.workflow_name,
        workflow_instance_id: parent.id,
        workflow_revision: newRev,
        plane: { work_item_id: parent.work_item_id,
                 module_id: parent.module_id,
                 cycle_id: parent.cycle_id }
      });
    } catch (e) {
      // Parent is still awaiting_approval; leave it so retry is safe.
      throw e;
    }
    await updateInstance(
      { work_item_id: parent.work_item_id, workflow_name: parent.workflow_name },
      { status: 'running', revision: newRev, current_step: firstAgent }
    );
    _emit('workflow.transitioned', {
      instance_id: parent.id, from_agent: 'pm', to_agent: firstAgent,
      reason: 'replan-resume'
    });
  } else {
    // replan blocked/failed → parent stays awaiting_approval; leave for human.
    _emit('workflow.finished', {
      instance_id: parent.id, status: 'awaiting_approval', reason: 'replan-failed'
    });
  }
}
