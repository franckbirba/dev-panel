// src/worker/predicates.js
// Each predicate is a pure function (result, jobData) => boolean.
// Referenced by name from workflow YAML `when:` clauses.

const P0_P1 = new Set(['p0', 'p1']);

export const predicates = {
  reviewer_rejected_pr(result) {
    const issues = result?.issues_found || [];
    return issues.some(i => P0_P1.has(i?.severity));
  },
  qa_infra_only(result) {
    const blockers = result?.blockers || [];
    if (blockers.length === 0) return false;
    return blockers.every(b => b?.kind === 'infra');
  }
};
