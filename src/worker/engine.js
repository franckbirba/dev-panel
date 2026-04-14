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
    const doc = parseYAML(raw);
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
    flows[doc.name] = doc;
  }

  for (const name of usedPredicates) {
    if (typeof predicates[name] !== 'function') {
      throw new Error(`unknown predicate: ${name}`);
    }
  }
  return flows;
}
