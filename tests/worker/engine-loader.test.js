// tests/worker/engine-loader.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadWorkflows, getCachedWorkflows, __resetWorkflowCacheForTests } from '../../src/worker/engine.js';

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

// Regression: pre-2026-05-09 the worker cached `loadWorkflows()` at first call
// and never reloaded. PR #67 added `blocked: { next: builder, when: … }` to
// merge-coordinator.yaml, deploy didn't restart the worker, and PR#17/#18
// burned ~30h in merge-coordinator → blocked-terminal because the in-process
// flow still had `blocked: { terminal: true }`. getCachedWorkflows() must
// observe a YAML mtime bump and reload.
describe('getCachedWorkflows (mtime-aware reload)', () => {
  beforeEach(() => __resetWorkflowCacheForTests());

  it('returns the same flow object on repeat calls when nothing on disk changed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-cache-'));
    writeFileSync(join(dir, 'a.yaml'),
      `name: stable\nmax_revisions: 1\non_exhaustion: block\nsteps:\n` +
      `  - agent: a\n    on:\n      done: { terminal: true }\n`);
    const first = getCachedWorkflows(dir);
    const second = getCachedWorkflows(dir);
    // Same identity = cache hit.
    expect(second).toBe(first);
  });

  it('reloads when a YAML on disk gets a newer mtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-cache-'));
    const file = join(dir, 'a.yaml');
    writeFileSync(file,
      `name: evolving\nmax_revisions: 1\non_exhaustion: block\nsteps:\n` +
      `  - agent: a\n    on:\n      done: { terminal: true }\n`);
    const first = getCachedWorkflows(dir);
    expect(first.evolving.steps[0].on.done.terminal).toBe(true);

    // Bump the YAML — switch the terminal:true to next:b plus a 2nd step.
    writeFileSync(file,
      `name: evolving\nmax_revisions: 1\non_exhaustion: block\nsteps:\n` +
      `  - agent: a\n    on:\n      done: { next: b }\n` +
      `  - agent: b\n    on:\n      done: { terminal: true }\n`);
    // Force the new mtime to be strictly greater (some filesystems quantise to
    // 1s, and the rewrite above can land in the same tick as the first write).
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);

    const second = getCachedWorkflows(dir);
    expect(second).not.toBe(first);
    expect(second.evolving.steps[0].on.done.next).toBe('b');
    expect(second.evolving.steps).toHaveLength(2);
  });
});
