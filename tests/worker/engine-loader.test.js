// tests/worker/engine-loader.test.js
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadWorkflows } from '../../src/worker/engine.js';

describe('loadWorkflows', () => {
  it('loads the shipped workflow YAMLs', () => {
    const flows = loadWorkflows();
    expect(Object.keys(flows).sort()).toEqual(['cycle-audit', 'merge-coordinator', 'replan', 'work-item']);
    expect(flows['work-item'].max_revisions).toBe(3);
    expect(flows['work-item'].steps.map(s => s.agent)).toEqual(['builder', 'reviewer', 'qa']);
  });

  it('rejects a YAML file that references an unknown predicate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-yaml-'));
    writeFileSync(join(dir, 'bad.yaml'),
      `name: bad\nmax_revisions: 1\non_exhaustion: block\nsteps:\n` +
      `  - agent: builder\n    on:\n      done: { next: reviewer, when: no_such_predicate }\n` +
      `  - agent: reviewer\n    on:\n      done: { terminal: true }\n`);
    expect(() => loadWorkflows(dir)).toThrow(/unknown predicate: no_such_predicate/);
  });

  it('rejects malformed YAML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-yaml-'));
    writeFileSync(join(dir, 'bad.yaml'), 'not: [valid: yaml');
    expect(() => loadWorkflows(dir)).toThrow();
  });

  it('rejects duplicate workflow names across files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-yaml-'));
    writeFileSync(join(dir, 'a.yaml'),
      `name: dup\nmax_revisions: 1\non_exhaustion: block\nsteps:\n` +
      `  - agent: x\n    on:\n      done: { terminal: true }\n`);
    writeFileSync(join(dir, 'b.yaml'),
      `name: dup\nmax_revisions: 1\non_exhaustion: block\nsteps:\n` +
      `  - agent: y\n    on:\n      done: { terminal: true }\n`);
    expect(() => loadWorkflows(dir)).toThrow(/duplicate workflow name: dup/);
  });

  it('rejects a next: target that is not a declared step agent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-yaml-'));
    writeFileSync(join(dir, 'bad.yaml'),
      `name: bad\nmax_revisions: 1\non_exhaustion: block\nsteps:\n` +
      `  - agent: a\n    on:\n      done: { next: ghost }\n`);
    expect(() => loadWorkflows(dir)).toThrow(/next:ghost is not a declared step agent/);
  });

  it('rejects a branch with no terminal/next/workflow action', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-yaml-'));
    writeFileSync(join(dir, 'bad.yaml'),
      `name: bad\nmax_revisions: 1\non_exhaustion: block\nsteps:\n` +
      `  - agent: a\n    on:\n      done: {}\n`);
    expect(() => loadWorkflows(dir)).toThrow(/branch has no action/);
  });

  it('rejects YAML with missing name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-yaml-'));
    writeFileSync(join(dir, 'noname.yaml'),
      `max_revisions: 1\non_exhaustion: block\nsteps:\n` +
      `  - agent: a\n    on:\n      done: { terminal: true }\n`);
    expect(() => loadWorkflows(dir)).toThrow(/missing name/);
  });

  it('rejects YAML with empty steps list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-yaml-'));
    writeFileSync(join(dir, 'nosteps.yaml'),
      `name: nosteps\nmax_revisions: 1\non_exhaustion: block\nsteps: []\n`);
    expect(() => loadWorkflows(dir)).toThrow(/has no steps/);
  });

  it('wraps YAML parse errors with the filename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-yaml-'));
    writeFileSync(join(dir, 'garbage.yaml'), 'name: ok\nsteps: [: bad');
    expect(() => loadWorkflows(dir)).toThrow(/workflow garbage\.yaml/);
  });
});
