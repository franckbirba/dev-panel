// src/worker/predicates.js
// Registry of named predicate functions referenced from workflow YAML
// `when:` clauses. Each is a pure function (result, jobData) => boolean.
//
// Some predicates are defined ahead of their first YAML use — they're
// listed in KNOWN_UNUSED so the dead-predicate test can skip them. When
// a YAML branch starts using one, remove it from KNOWN_UNUSED.
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

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
  },
  // Gap #1 (2026-05-25): tool-error feedback loop.
  // Reads result.tool_error_count, which the worker attaches to parsed.data
  // after spawnAgent resolves (option (a) — propagation via the result object,
  // not via DB lookup of the synthetic system event). Chose (a) because the
  // result object is already the predicate's first argument, requires no
  // engine-side I/O, and stays pure for tests. The synthetic event still gets
  // persisted via appendEvent for observability (dashboard timeline + audit).
  tool_errors_excessive(result /* , jobData */) {
    const count = result?.tool_error_count ?? 0;
    const threshold = parseInt(process.env.WORKER_TOOL_ERROR_THRESHOLD || '5', 10);
    return count >= threshold;
  },

  // ADR-006 §Décision 3 — prédicats vérifiés, pas déclarés. A loop `until:
  // tests_green` must not exit on the agent's say-so (result.artifacts.
  // tests_passed); it exits when the WORKER runs the repo's declared test
  // command and it exits 0. Same philosophy as automation.js#verifyAndCommit
  // ("vérifier, pas croire") applied to loop-exit predicates.
  //
  // Reads .devpanlrc.json#commands.test in the job's worktree
  // (jobData.context.worktree_path). No worktree, no .devpanlrc.json, or no
  // commands.test declared → mechanizable check unavailable, predicate
  // returns false (fail closed: the loop keeps going / falls through to
  // whatever branch handles "not done yet", never silently exits on a check
  // that never ran). This matches ADR-006's documented fallback: "un repo
  // sans .devpanlrc.json#commands n'a pas de boucle interne vérifiée".
  tests_green(result, jobData) {
    const worktreePath = jobData?.context?.worktree_path;
    if (!worktreePath || !existsSync(worktreePath)) return false;

    let testCommand;
    try {
      const rcPath = join(worktreePath, '.devpanelrc.json');
      if (!existsSync(rcPath)) return false;
      const rc = JSON.parse(readFileSync(rcPath, 'utf8'));
      testCommand = rc?.commands?.test;
      if (!testCommand || typeof testCommand !== 'string') return false;
    } catch {
      return false; // malformed .devpanelrc.json — can't mechanize, fail closed
    }

    try {
      execSync(testCommand, { cwd: worktreePath, stdio: 'pipe', timeout: 10 * 60 * 1000 });
      return true;
    } catch {
      // Non-zero exit, timeout, or spawn error all mean "not green".
      return false;
    }
  }
};

// Intentionally defined but not yet referenced by any shipped workflow.
// - qa_infra_only: spec §10.3, reserved for a retry path we'll add to
//   work-item.yaml the first time a real infra flake shows up.
// - merge_blocked_fixable: was used by the old loop-y merge-coordinator
//   workflow that retreated to a builder. Phase A (2026-05-08) narrowed
//   merge-coordinator to single-shot, so the predicate is orphaned —
//   kept around because Phase B may reintroduce a builder retreat.
export const KNOWN_UNUSED = Object.freeze([
  'qa_infra_only',
  'merge_blocked_fixable',
  // added 2026-05-25 for harness Gap #1, awaiting first workflow consumer
  'tool_errors_excessive',
  // ADR-006 §Décision 3 (2026-08-18): mechanized loop-exit predicate for
  // `until: tests_green`. No shipped YAML declares a graph-format loop yet
  // (the 4 prod workflows are still legacy steps:) — first consumer lands
  // with the first hand-authored loops: block, tracked separately.
  'tests_green'
]);
