// tests/worker/engine-graph.test.js
// ADR-006 — graphe explicite + boucles bornées.
//
// Core rule under test: every cycle in a workflow's graph MUST belong to a
// DECLARED loop — one with `until`, `max_iterations`, and a budget. A cycle
// that isn't wrapped in a declared loop is rejected at load time, by name.
//
// Two input shapes are covered:
//  - legacy `steps:` (the 4 shipped YAMLs) — cycles there are auto-wrapped
//    into a synthesized loop (bounded by max_revisions), so they load fine.
//  - new `nodes:` + `edges:` + `loops:` — hand-authored graphs are held to
//    the full rule: any cycle not covered by a `loops[]` entry with
//    `until` + `max_iterations` + `budget_tokens` is rejected.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadWorkflows } from '../../src/worker/engine.js';

function writeFlow(dir, filename, yaml) {
  writeFileSync(join(dir, filename), yaml);
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'dp-graph-'));
}

describe('loadWorkflows — graph format (nodes/edges/loops)', () => {
  it('accepts an acyclic graph with no loops declared', () => {
    const dir = tmpDir();
    writeFlow(dir, 'ok.yaml', `
name: ok-acyclic
nodes:
  - id: build
    agent: builder
  - id: review
    agent: reviewer
edges:
  - { from: build, on: done, to: review }
  - { from: review, on: done, terminal: true }
`);
    const flows = loadWorkflows(dir);
    expect(flows['ok-acyclic']).toBeTruthy();
    expect(flows['ok-acyclic'].graph.nodes.map(n => n.id)).toEqual(['build', 'review']);
  });

  it('rejects a cycle that is not covered by any declared loop', () => {
    const dir = tmpDir();
    writeFlow(dir, 'bad.yaml', `
name: bad-undeclared-cycle
nodes:
  - id: build
    agent: builder
  - id: review
    agent: reviewer
edges:
  - { from: build, on: done, to: review }
  - { from: review, on: failed, to: build }
  - { from: review, on: done, terminal: true }
`);
    expect(() => loadWorkflows(dir)).toThrow(/undeclared cycle/i);
    // Message names the cycle so "pourquoi ça boucle" is a YAML-reading question.
    expect(() => loadWorkflows(dir)).toThrow(/build/);
    expect(() => loadWorkflows(dir)).toThrow(/review/);
  });

  it('rejects a declared loop missing `until`', () => {
    const dir = tmpDir();
    writeFlow(dir, 'bad.yaml', `
name: bad-no-until
nodes:
  - id: build
    agent: builder
  - id: review
    agent: reviewer
loops:
  - id: revision
    body: [build, review]
    max_iterations: 3
    budget_tokens: 100000
    on_exhaustion: block
edges:
  - { from: build, on: done, to: review }
  - { from: review, on: failed, to: build }
  - { from: review, on: done, terminal: true }
`);
    expect(() => loadWorkflows(dir)).toThrow(/loop "revision".*until/is);
  });

  it('rejects a declared loop missing `max_iterations`', () => {
    const dir = tmpDir();
    writeFlow(dir, 'bad.yaml', `
name: bad-no-max-iterations
nodes:
  - id: build
    agent: builder
  - id: review
    agent: reviewer
loops:
  - id: revision
    body: [build, review]
    until: review_done
    budget_tokens: 100000
    on_exhaustion: block
edges:
  - { from: build, on: done, to: review }
  - { from: review, on: failed, to: build }
  - { from: review, on: done, terminal: true }
`);
    expect(() => loadWorkflows(dir)).toThrow(/loop "revision".*max_iterations/is);
  });

  it('rejects a declared loop missing budget_tokens', () => {
    const dir = tmpDir();
    writeFlow(dir, 'bad.yaml', `
name: bad-no-budget
nodes:
  - id: build
    agent: builder
  - id: review
    agent: reviewer
loops:
  - id: revision
    body: [build, review]
    until: review_done
    max_iterations: 3
    on_exhaustion: block
edges:
  - { from: build, on: done, to: review }
  - { from: review, on: failed, to: build }
  - { from: review, on: done, terminal: true }
`);
    expect(() => loadWorkflows(dir)).toThrow(/loop "revision".*budget/is);
  });

  it('accepts a fully-declared loop (until + max_iterations + budget)', () => {
    const dir = tmpDir();
    writeFlow(dir, 'ok.yaml', `
name: ok-declared-loop
nodes:
  - id: build
    agent: builder
  - id: review
    agent: reviewer
  - id: qa
    agent: qa
loops:
  - id: revision
    body: [build, review]
    until: review_done
    max_iterations: 3
    budget_tokens: 400000
    on_exhaustion: block
edges:
  - { from: build, on: done, to: review }
  - { from: review, on: failed, when: reviewer_rejected_pr, to: build }
  - { from: review, on: done, to: qa }
  - { from: qa, on: done, terminal: true }
`);
    const flows = loadWorkflows(dir);
    const flow = flows['ok-declared-loop'];
    expect(flow.graph.loops).toHaveLength(1);
    expect(flow.graph.loops[0].id).toBe('revision');
    expect(flow.graph.loops[0].max_iterations).toBe(3);
    expect(flow.graph.loops[0].budget_tokens).toBe(400000);
  });

  it('rejects a loop whose body does not actually contain a cycle edge (declared but bogus)', () => {
    // Guards against a loop block that references nodes but the edges never
    // actually form a cycle among them — the declaration would be a lie.
    const dir = tmpDir();
    writeFlow(dir, 'bad.yaml', `
name: bad-loop-no-real-cycle
nodes:
  - id: build
    agent: builder
  - id: review
    agent: reviewer
loops:
  - id: revision
    body: [build, review]
    until: review_done
    max_iterations: 3
    budget_tokens: 100000
    on_exhaustion: block
edges:
  - { from: build, on: done, to: review }
  - { from: review, on: done, terminal: true }
`);
    expect(() => loadWorkflows(dir)).toThrow(/loop "revision".*no cycle/is);
  });

  it('rejects an edge whose `to` is not a declared node id', () => {
    const dir = tmpDir();
    writeFlow(dir, 'bad.yaml', `
name: bad-ghost-node
nodes:
  - id: build
    agent: builder
edges:
  - { from: build, on: done, to: ghost }
`);
    expect(() => loadWorkflows(dir)).toThrow(/ghost/);
  });

  it('supports multi-node cycles (3+ nodes) in the DFS detector', () => {
    const dir = tmpDir();
    writeFlow(dir, 'bad.yaml', `
name: bad-triangle-cycle
nodes:
  - id: a
    agent: a
  - id: b
    agent: b
  - id: c
    agent: c
edges:
  - { from: a, on: done, to: b }
  - { from: b, on: done, to: c }
  - { from: c, on: done, to: a }
`);
    expect(() => loadWorkflows(dir)).toThrow(/undeclared cycle/i);
  });

  it('a fully-declared triangle loop is accepted', () => {
    const dir = tmpDir();
    writeFlow(dir, 'ok.yaml', `
name: ok-triangle-loop
nodes:
  - id: a
    agent: a
  - id: b
    agent: b
  - id: c
    agent: c
loops:
  - id: cycle3
    body: [a, b, c]
    until: c_done
    max_iterations: 5
    budget_tokens: 50000
    on_exhaustion: block
edges:
  - { from: a, on: done, to: b }
  - { from: b, on: done, to: c }
  - { from: c, on: retry, to: a }
  - { from: c, on: done, terminal: true }
`);
    const flows = loadWorkflows(dir);
    expect(flows['ok-triangle-loop'].graph.loops[0].body).toEqual(['a', 'b', 'c']);
  });
});

describe('loadWorkflows — legacy steps: format stays backward compatible', () => {
  it('loads the 4 shipped legacy YAMLs and synthesizes an internal graph', () => {
    const flows = loadWorkflows();
    expect(Object.keys(flows).sort()).toEqual(['cycle-audit', 'merge-coordinator', 'replan', 'work-item']);
    for (const flow of Object.values(flows)) {
      expect(flow.graph).toBeTruthy();
      expect(Array.isArray(flow.graph.nodes)).toBe(true);
      expect(Array.isArray(flow.graph.edges)).toBe(true);
      expect(Array.isArray(flow.graph.loops)).toBe(true);
    }
    // work-item's reviewer.failed→builder cycle must be captured as a
    // synthesized loop bounded by max_revisions (3).
    const wi = flows['work-item'];
    expect(wi.graph.loops.length).toBeGreaterThanOrEqual(1);
    const revisionLoop = wi.graph.loops.find(l =>
      l.body.includes('builder') && l.body.includes('reviewer'));
    expect(revisionLoop).toBeTruthy();
    expect(revisionLoop.max_iterations).toBe(3);
  });

  it('legacy steps: format with an undeclared-looking cycle still loads (auto-wrapped)', () => {
    const dir = tmpDir();
    writeFlow(dir, 'legacy.yaml', `
name: legacy-cycle
max_revisions: 2
on_exhaustion: block
steps:
  - agent: builder
    on:
      done: { next: reviewer }
      failed: { terminal: true }
  - agent: reviewer
    on:
      done: { terminal: true }
      failed: { next: builder }
`);
    const flows = loadWorkflows(dir);
    expect(flows['legacy-cycle'].graph.loops.length).toBeGreaterThanOrEqual(1);
  });
  // Trous trouvés en review (2026-08-20) — deux corrections vérifiées ici.
  it('rejette un cycle inclus dans un body mais qui n\'emprunte PAS le back-edge compté', () => {
    // Le compteur d'itérations ne s'incrémente que sur body[last] -> body[0].
    // Un self-loop b->b dans un body [a,b] passait la règle "sous-ensemble"
    // tout en ne consommant jamais ni compteur ni budget.
    const dir = tmpDir();
    writeFlow(dir, 'sneaky.yaml', `
name: sneaky-selfloop
nodes:
  - { id: a, agent: builder }
  - { id: b, agent: reviewer }
loops:
  - id: outer
    body: [a, b]
    until: reviewer_rejected_pr
    max_iterations: 3
    budget_tokens: 400000
    on_exhaustion: block
edges:
  - { from: a, on: done, to: b }
  - { from: b, on: failed, to: a }
  - { from: b, on: blocked, to: b }
  - { from: b, on: done, terminal: true }
`);
    expect(() => loadWorkflows(dir)).toThrow(/back-edge|undeclared cycle/i);
  });

  it('accepte le cycle qui emprunte bien le back-edge déclaré', () => {
    const dir = tmpDir();
    writeFlow(dir, 'ok.yaml', `
name: proper-loop
nodes:
  - { id: a, agent: builder }
  - { id: b, agent: reviewer }
loops:
  - id: revision
    body: [a, b]
    until: reviewer_rejected_pr
    max_iterations: 3
    budget_tokens: 400000
    on_exhaustion: block
edges:
  - { from: a, on: done, to: b }
  - { from: b, on: failed, to: a }
  - { from: b, on: done, terminal: true }
`);
    const flows = loadWorkflows(dir);
    expect(flows['proper-loop'].graph.loops[0].id).toBe('revision');
  });
});
