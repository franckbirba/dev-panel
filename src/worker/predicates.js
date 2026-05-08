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
  },
  // merge-coordinator: fork the conflict-resolve branch only when the bail
  // is something a builder can plausibly fix. Hard-human gates (state, draft,
  // untrusted, changes_requested, labels, fork rebase) stay terminal.
  // Inputs: result.blockers may be array-of-strings or array-of-objects;
  // result.summary carries `gate=<name>:` from the SOUL output schema.
  merge_blocked_fixable(result) {
    const HARD_GATES = new Set([
      'state', 'draft', 'untrusted_author', 'changes_requested',
      'fork_needs_rebase', 'label'
    ]);
    const summary = String(result?.summary || '');
    const m = summary.match(/gate=([a-z_]+)/i);
    const gate = m ? m[1].toLowerCase() : null;
    if (gate && HARD_GATES.has(gate)) return false;
    if (gate === 'label') return false; // belt-and-suspenders for label:foo
    if (summary.toLowerCase().includes('gate=label:')) return false;
    // ci_pending and rebase_pushed are wait-states; the next webhook re-enters.
    // Don't burn a builder retry — let the cron/webhook drive.
    if (gate === 'ci_pending' || gate === 'rebase_pushed') return false;
    // Anything else (conflicts_complex, check_failed, head_moved, unknown) →
    // try a builder pass to fix the code, then bounce back to merge-coordinator.
    return true;
  }
};

// Intentionally defined but not yet referenced by any shipped workflow.
// - qa_infra_only: spec §10.3, reserved for a retry path we'll add to
//   work-item.yaml the first time a real infra flake shows up.
// - merge_blocked_fixable: was used by the old loop-y merge-coordinator
//   workflow that retreated to a builder. Phase A (2026-05-08) narrowed
//   merge-coordinator to single-shot, so the predicate is orphaned —
//   kept around because Phase B may reintroduce a builder retreat.
export const KNOWN_UNUSED = Object.freeze(['qa_infra_only', 'merge_blocked_fixable']);
