// tests/worker/predicates.test.js
import { describe, it, expect } from 'vitest';
import { predicates, KNOWN_UNUSED } from '../../src/worker/predicates.js';
import { loadWorkflows } from '../../src/worker/engine.js';

describe('predicates', () => {
  it('reviewer_rejected_pr — true on p1+ issue', () => {
    expect(predicates.reviewer_rejected_pr({
      issues_found: [{ severity: 'p1', title: 'x' }]
    })).toBe(true);
    expect(predicates.reviewer_rejected_pr({
      issues_found: [{ severity: 'p3', title: 'nit' }]
    })).toBe(false);
    expect(predicates.reviewer_rejected_pr({ issues_found: [] })).toBe(false);
    expect(predicates.reviewer_rejected_pr({})).toBe(false);
  });
  it('qa_infra_only — true iff every blocker.kind is "infra"', () => {
    expect(predicates.qa_infra_only({
      blockers: [{ kind: 'infra' }, { kind: 'infra' }]
    })).toBe(true);
    expect(predicates.qa_infra_only({
      blockers: [{ kind: 'infra' }, { kind: 'code' }]
    })).toBe(false);
    expect(predicates.qa_infra_only({ blockers: [] })).toBe(false);
  });
});

describe('predicate-YAML consistency', () => {
  it('every exported predicate (except KNOWN_UNUSED) is referenced by at least one shipped workflow', () => {
    const flows = loadWorkflows();
    const used = new Set();
    for (const flow of Object.values(flows)) {
      for (const step of flow.steps) {
        for (const branch of Object.values(step.on || {})) {
          if (branch?.when) used.add(branch.when);
        }
      }
    }
    const exported = Object.keys(predicates);
    const orphans = exported.filter(n => !used.has(n) && !KNOWN_UNUSED.includes(n));
    expect(orphans).toEqual([]);
  });
});
