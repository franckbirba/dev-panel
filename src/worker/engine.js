// src/worker/engine.js
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYAML } from 'yaml';
import { predicates } from './predicates.js';

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
