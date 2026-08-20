// src/worker/engine.js
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYAML } from 'yaml';
import { predicates } from './predicates.js';
import { buildWorkflowGraph, firstAgentOf } from './workflow-graph.js';
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

// ADR-006 — two YAML shapes are accepted:
//   - legacy `steps:` (list + `on:` transitions) — the 4 shipped workflows.
//   - new `nodes:` + `edges:` + `loops:` (graph, hand-authored loops).
// Both are validated for step/branch/predicate integrity as before, then
// BOTH get a `flow.graph = { nodes, edges, loops }` built by
// buildWorkflowGraph() — which is where the cycle-must-be-declared rule
// lives (workflow-graph.js). Legacy flows keep `flow.steps` untouched so
// triggerNext()/dispatch.js need no changes to keep working.
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

    const isGraphFormat = Array.isArray(doc.nodes) || Array.isArray(doc.edges);
    if (isGraphFormat) {
      if (!Array.isArray(doc.nodes) || doc.nodes.length === 0) {
        throw new Error(`workflow ${doc.name} has no nodes`);
      }
      for (const node of doc.nodes) {
        if (!node?.id) throw new Error(`workflow ${doc.name}: node missing id`);
      }
      for (const edge of doc.edges || []) {
        if (edge?.when) usedPredicates.add(edge.when);
      }
    } else {
      if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
        throw new Error(`workflow ${doc.name} has no steps`);
      }
      // Collect predicate references and validate they resolve.
      for (const step of doc.steps) {
        for (const branch of Object.values(step.on || {})) {
          if (branch?.when) usedPredicates.add(branch.when);
        }
      }
    }
    doc.on_exhaustion = doc.on_exhaustion || 'block';

    if (flows[doc.name]) {
      throw new Error(`duplicate workflow name: ${doc.name} (in ${f})`);
    }
    flows[doc.name] = doc;
  }

  for (const flow of Object.values(flows)) {
    if (Array.isArray(flow.steps)) {
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
  }

  for (const name of usedPredicates) {
    if (typeof predicates[name] !== 'function') {
      throw new Error(`unknown predicate: ${name}`);
    }
  }

  // ADR-006 §Décision 1 — the validator: every cycle MUST belong to a
  // declared loop (until + max_iterations + budget_tokens). Runs after the
  // shape-specific checks above so a malformed doc fails with the clearer
  // "no steps" / "no nodes" message first.
  for (const flow of Object.values(flows)) {
    flow.graph = buildWorkflowGraph(flow);
  }

  return flows;
}

// findStep works against BOTH shapes. Legacy flows have flow.steps
// directly. Graph-format flows (nodes:/edges:/loops:, no steps:) get a
// steps-shaped view synthesized on the fly from flow.graph so the rest of
// triggerNext (pickBranch, applyRetreat) doesn't need two code paths.
function findStep(flow, agent) {
  if (Array.isArray(flow.steps)) {
    return flow.steps.find(s => s.agent === agent);
  }
  return stepFromGraph(flow, agent);
}

// Node `id` is the graph identity (what edges/loop bodies reference).
// Node `agent` is the dispatch identity (what jobData.agent / enque({agent})
// use — defaults to `id` when a node doesn't set `agent` explicitly, so
// nodes: [{id: build, agent: builder}] and nodes: [{id: builder}] both work.
function nodeAgent(node) {
  return node?.agent || node?.id;
}

function findNodeByAgent(flow, agent) {
  return flow.graph?.nodes.find(n => nodeAgent(n) === agent) || null;
}

function stepFromGraph(flow, agent) {
  const node = findNodeByAgent(flow, agent);
  if (!node) return null;
  const on = {};
  for (const edge of flow.graph.edges) {
    if (edge.from !== node.id) continue;
    const branch = {};
    if (edge.when) branch.when = edge.when;
    if (edge.terminal) {
      branch.terminal = true;
    } else if (edge.workflow) {
      branch.workflow = edge.workflow;
      branch.next = edge.to; // cross-workflow jump target is an agent name already (e.g. 'pm')
    } else {
      const targetNode = flow.graph.nodes.find(n => n.id === edge.to);
      branch.next = targetNode ? nodeAgent(targetNode) : edge.to;
    }
    // Multiple edges can share the same `on:` status when they're
    // predicate-gated alternatives (when:) — pickBranch only supports one
    // branch per status today (matches legacy `on: { status: {...} }`
    // shape), so first-declared wins per status. V1 has no such case in
    // shipped/tested graphs; documented here for the next author.
    if (!on[edge.on]) on[edge.on] = branch;
  }
  return { agent: nodeAgent(node), on, retreat_allowed: node.retreat_allowed, _nodeId: node.id };
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

// ADR-006 §Décision 1/2 — find the declared loop (if any) this transition
// CLOSES, i.e. consumes one iteration of. `loop.body` is an ORDERED list
// of node ids describing the cycle's path (ADR-006 example: [build,
// review] means build -> review -> (back to) build). Only the back-edge —
// body[last] -> body[0] — is the edge that actually re-enters the loop and
// should consume budget; a forward edge like build -> review (index 0 -> 1)
// is normal traversal INTO the loop, not a repeat of it, and must not be
// double-counted. Everything else (edges that leave the loop, or aren't
// part of any declared loop) falls back to the workflow's existing global
// revision/max_revisions guard — unchanged legacy behavior.
//
// fromAgent/toAgent are dispatch agent names (jobData.agent / effective.
// next); loop bodies are declared in node ids, so translate both before
// comparing (id != agent when a node sets `agent` explicitly — legacy
// flows have no such split, so this is a no-op there).
function findLoopForTransition(flow, fromAgent, toAgent) {
  const loops = flow.graph?.loops;
  if (!loops || loops.length === 0) return null;
  const fromId = findNodeByAgent(flow, fromAgent)?.id ?? fromAgent;
  const toId = findNodeByAgent(flow, toAgent)?.id ?? toAgent;
  return loops.find(loop => {
    const body = loop.body || [];
    if (body.length === 0) return false;
    return body[body.length - 1] === fromId && body[0] === toId;
  }) || null;
}

function getLoopCounters(instance) {
  try {
    const meta = instance.metadata ? JSON.parse(instance.metadata) : null;
    return { ...(meta?.loop_counters || {}) };
  } catch {
    return {};
  }
}

function mergeMetadata(instance, patch) {
  let meta;
  try { meta = instance.metadata ? JSON.parse(instance.metadata) : {}; }
  catch { meta = {}; }
  return { ...meta, ...patch };
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
      // forward-transition enqueue below for full rationale). parent_context
      // (DEVPA-228) is caller-controlled inheritance for the INITIAL dispatch
      // only — engine-driven forwards must not re-inject it.
      const { worktree_path: _wtPath, parent_context: _pc, ...replanContext } = jobData.context || {};
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
    // ADR-006 §Décision 1/2 — if this edge closes a declared loop (both
    // endpoints in the loop's body), bound it by THAT loop's own
    // max_iterations/budget, counted independently per loop id, instead of
    // the single anonymous global revision counter. Transitions outside any
    // declared loop (e.g. leaving the loop toward the next step) keep using
    // the existing global revision/max_revisions guard — unchanged behavior
    // for legacy flows and for non-loop edges in graph-format flows.
    const loop = findLoopForTransition(flow, jobData.agent, effective.next);
    let loopCounters = null;
    if (loop) {
      loopCounters = getLoopCounters(instance);
      const nextCount = (loopCounters[loop.id] || 0) + 1;
      if (nextCount > loop.max_iterations) {
        return applyLoopExhaustion(instance, flow, loop, _emit);
      }
      loopCounters[loop.id] = nextCount;
    } else {
      const currentRev = jobData.workflow_revision ?? instance.revision;
      if (currentRev >= flow.max_revisions) {
        return applyExhaustion(instance, flow, _emit);
      }
    }
    const currentRev = jobData.workflow_revision ?? instance.revision;
    // Sanitize context before forwarding. Per-spawn fields (worktree_path)
    // belong to the CURRENT job only — the next agent will derive its own
    // worktree in src/worker/index.js. Carrying worktree_path forward was
    // the structural cause of canary 2129 (DEVPA-155, 2026-05-08): the
    // verifier in the next step inherited a path that prepareWorktree had
    // already reclaimed. Workflow-level fields (branch, default_branch,
    // project_root, github_issue_number, devpanel_ticket_id, etc.) propagate.
    // parent_context (DEVPA-228) is caller-controlled inheritance for the
    // INITIAL dispatch only — engine-driven forwards must not re-inject it.
    const { worktree_path, parent_context, ...workflow_context } = jobData.context || {};
    await enqueue({
      agent: effective.next,
      workflow: flow.name,
      workflow_instance_id: instance.id,
      workflow_revision: currentRev,
      plane: jobData.plane,
      work_item: jobData.work_item,
      context: workflow_context
    });
    const patch = { current_step: effective.next, last_job_id: jobData.job_id };
    if (loopCounters) patch.metadata = mergeMetadata(instance, { loop_counters: loopCounters });
    await updateInstance({ work_item_id: workItemId, workflow_name: flow.name }, patch);
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

// ADR-006 §Arbitrages (2026-08-18) — loop budget exhaustion ends the
// ATTEMPT, never the work item: the instance goes to 'exhausted' with a
// diagnostic (which loop, how many iterations), same terminal status as
// applyExhaustion's global path, so dashboards/backlog-return logic don't
// need to distinguish the two. `on_exhaustion: block` (the only value the
// 4 shipped workflows and current dashboard UX handle) and `escalate` are
// treated identically for now — 'escalate' ships its button UX later, same
// deferral as applyExhaustion above.
async function applyLoopExhaustion(instance, flow, loop, _emit) {
  await updateInstance(
    { work_item_id: instance.work_item_id, workflow_name: flow.name },
    {
      status: 'exhausted',
      metadata: mergeMetadata(instance, {
        exhausted_loop: { id: loop.id, max_iterations: loop.max_iterations, on_exhaustion: loop.on_exhaustion }
      })
    }
  );
  _emit('workflow.finished', {
    instance_id: instance.id, status: 'exhausted',
    reason: 'loop-exhausted', loop_id: loop.id, max_iterations: loop.max_iterations
  });
  return { action: 'exhausted', loop_id: loop.id };
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
    const firstAgent = firstAgentOf(parentFlow);
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
