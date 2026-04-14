// src/worker/predicates.js
// Registry of named predicate functions referenced from workflow YAML
// `when:` clauses. Each is a pure function (result, jobData) => boolean.
//
// Some predicates are defined ahead of their first YAML use — they're
// listed in KNOWN_UNUSED so the dead-predicate test can skip them. When
// a YAML branch starts using one, remove it from KNOWN_UNUSED.

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

// Intentionally defined but not yet referenced by any shipped workflow.
// Spec §10.3 reserves qa_infra_only for a retry path we'll add to
// work-item.yaml the first time a real infra flake shows up.
export const KNOWN_UNUSED = Object.freeze(['qa_infra_only']);
