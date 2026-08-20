// tests/worker/predicates.test.js
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

  describe('tool_errors_excessive (Gap #1, 2026-05-25)', () => {
    const ORIGINAL_THRESHOLD = process.env.WORKER_TOOL_ERROR_THRESHOLD;
    afterEach(() => {
      if (ORIGINAL_THRESHOLD === undefined) delete process.env.WORKER_TOOL_ERROR_THRESHOLD;
      else process.env.WORKER_TOOL_ERROR_THRESHOLD = ORIGINAL_THRESHOLD;
    });

    it('returns true when count >= threshold (default 5)', () => {
      delete process.env.WORKER_TOOL_ERROR_THRESHOLD;
      expect(predicates.tool_errors_excessive({ tool_error_count: 5 })).toBe(true);
      expect(predicates.tool_errors_excessive({ tool_error_count: 12 })).toBe(true);
    });

    it('returns false when count < threshold', () => {
      delete process.env.WORKER_TOOL_ERROR_THRESHOLD;
      expect(predicates.tool_errors_excessive({ tool_error_count: 0 })).toBe(false);
      expect(predicates.tool_errors_excessive({ tool_error_count: 4 })).toBe(false);
    });

    it('returns false when tool_error_count is missing (legacy result shape)', () => {
      delete process.env.WORKER_TOOL_ERROR_THRESHOLD;
      expect(predicates.tool_errors_excessive({})).toBe(false);
      expect(predicates.tool_errors_excessive(null)).toBe(false);
    });

    it('honours WORKER_TOOL_ERROR_THRESHOLD env override', () => {
      process.env.WORKER_TOOL_ERROR_THRESHOLD = '2';
      expect(predicates.tool_errors_excessive({ tool_error_count: 1 })).toBe(false);
      expect(predicates.tool_errors_excessive({ tool_error_count: 2 })).toBe(true);
    });
  });

  describe('tests_green (ADR-006 §D3 — verified, not declared)', () => {
    let dir;
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

    // Canonical target-repo config name (no "e" — src/worker/index.js:22,
    // ADR-003 R1, scripts/bench/sandbox-seed/.devpanlrc.json all agree).
    function makeWorktree(commandsTest, rcName = '.devpanlrc.json') {
      dir = mkdtempSync(join(tmpdir(), 'dp-tests-green-'));
      if (commandsTest !== undefined) {
        writeFileSync(join(dir, rcName), JSON.stringify({
          commands: { test: commandsTest }
        }));
      }
      return dir;
    }

    it('runs commands.test in the worktree and returns true on exit 0', () => {
      const wt = makeWorktree('true');
      expect(predicates.tests_green({}, { context: { worktree_path: wt } })).toBe(true);
    });

    it('returns false when commands.test exits non-zero', () => {
      const wt = makeWorktree('false');
      expect(predicates.tests_green({}, { context: { worktree_path: wt } })).toBe(false);
    });

    it('does NOT trust result.artifacts.tests_passed — runs the real command regardless', () => {
      const wt = makeWorktree('false');
      // Agent claims tests passed; the worker must verify, not believe it.
      const result = { artifacts: { tests_passed: true } };
      expect(predicates.tests_green(result, { context: { worktree_path: wt } })).toBe(false);
    });

    it('returns false (fail closed) when worktree_path is missing', () => {
      expect(predicates.tests_green({}, { context: {} })).toBe(false);
      expect(predicates.tests_green({}, {})).toBe(false);
      expect(predicates.tests_green({})).toBe(false);
    });

    it('returns false (fail closed) when the worktree does not exist on disk', () => {
      expect(predicates.tests_green({}, { context: { worktree_path: '/no/such/path/xyz' } })).toBe(false);
    });

    it('returns false (fail closed) when the rc file is missing entirely', () => {
      const wt = makeWorktree(undefined);
      expect(predicates.tests_green({}, { context: { worktree_path: wt } })).toBe(false);
    });

    it('returns false (fail closed) when commands.test is not declared', () => {
      dir = mkdtempSync(join(tmpdir(), 'dp-tests-green-'));
      writeFileSync(join(dir, '.devpanlrc.json'), JSON.stringify({ project: 'x' }));
      expect(predicates.tests_green({}, { context: { worktree_path: dir } })).toBe(false);
    });

    it('returns false (fail closed) on malformed rc file', () => {
      dir = mkdtempSync(join(tmpdir(), 'dp-tests-green-'));
      writeFileSync(join(dir, '.devpanlrc.json'), 'not json{{{');
      expect(predicates.tests_green({}, { context: { worktree_path: dir } })).toBe(false);
    });

    it('falls back to .devpanelrc.json (with "e") when .devpanlrc.json is absent', () => {
      // Historical second spelling used by the dev-panel CLI for its own
      // project config. A target repo that happens to use it must still work.
      const wt = makeWorktree('true', '.devpanelrc.json');
      expect(predicates.tests_green({}, { context: { worktree_path: wt } })).toBe(true);
    });

    it('prefers .devpanlrc.json over .devpanelrc.json when both are present', () => {
      dir = mkdtempSync(join(tmpdir(), 'dp-tests-green-'));
      writeFileSync(join(dir, '.devpanlrc.json'), JSON.stringify({ commands: { test: 'true' } }));
      writeFileSync(join(dir, '.devpanelrc.json'), JSON.stringify({ commands: { test: 'false' } }));
      expect(predicates.tests_green({}, { context: { worktree_path: dir } })).toBe(true);
    });
  });

  it('merge_blocked_fixable — fixable gates route to builder, hard gates stay terminal', () => {
    // Fixable — workflow dispatches a builder pass.
    expect(predicates.merge_blocked_fixable({ summary: 'gate=conflicts_complex: 4 fichiers' })).toBe(true);
    expect(predicates.merge_blocked_fixable({ summary: 'gate=check_failed:test: 3 tests rouges' })).toBe(true);
    expect(predicates.merge_blocked_fixable({ summary: 'gate=head_moved: race on push' })).toBe(true);
    expect(predicates.merge_blocked_fixable({ summary: 'no gate at all' })).toBe(true); // unknown → try

    // Hard human-decision gates — terminal.
    expect(predicates.merge_blocked_fixable({ summary: 'gate=state: PR closed' })).toBe(false);
    expect(predicates.merge_blocked_fixable({ summary: 'gate=draft: marked draft' })).toBe(false);
    expect(predicates.merge_blocked_fixable({ summary: 'gate=untrusted_author' })).toBe(false);
    expect(predicates.merge_blocked_fixable({ summary: 'gate=changes_requested' })).toBe(false);
    expect(predicates.merge_blocked_fixable({ summary: 'gate=fork_needs_rebase' })).toBe(false);
    expect(predicates.merge_blocked_fixable({ summary: 'gate=label:do-not-merge' })).toBe(false);

    // Wait-states — let the next webhook drive, don't burn a builder pass.
    expect(predicates.merge_blocked_fixable({ summary: 'gate=ci_pending: 2 actions running' })).toBe(false);
    expect(predicates.merge_blocked_fixable({ summary: 'gate=rebase_pushed: waiting for sync' })).toBe(false);
  });
});

describe('predicate-YAML consistency', () => {
  it('every exported predicate (except KNOWN_UNUSED) is referenced by at least one shipped workflow', () => {
    const flows = loadWorkflows();
    const used = new Set();
    // Parcourt le graphe normalisé plutôt que `flow.steps` : loadWorkflows
    // le synthétise pour les deux formats, donc ce test reste valable quel
    // que soit le YAML (legacy `steps:` ou graphe `nodes:`/`edges:`).
    for (const flow of Object.values(flows)) {
      for (const edge of flow.graph?.edges || []) {
        if (edge?.when) used.add(edge.when);
      }
      for (const loop of flow.graph?.loops || []) {
        if (loop?.until) used.add(loop.until);
      }
    }
    const exported = Object.keys(predicates);
    const orphans = exported.filter(n => !used.has(n) && !KNOWN_UNUSED.includes(n));
    expect(orphans).toEqual([]);
  });
});
