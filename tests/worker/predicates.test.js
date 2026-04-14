// tests/worker/predicates.test.js
import { describe, it, expect } from 'vitest';
import { predicates } from '../../src/worker/predicates.js';

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
