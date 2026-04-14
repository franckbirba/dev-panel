// tests/worker/engine-loader.test.js
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadWorkflows } from '../../src/worker/engine.js';

describe('loadWorkflows', () => {
  it('loads the three shipped workflow YAMLs', () => {
    const flows = loadWorkflows();
    expect(Object.keys(flows).sort()).toEqual(['cycle-audit', 'replan', 'work-item']);
    expect(flows['work-item'].max_revisions).toBe(3);
    expect(flows['work-item'].steps.map(s => s.agent)).toEqual(['builder', 'reviewer', 'qa']);
  });

  it('rejects a YAML file that references an unknown predicate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-yaml-'));
    writeFileSync(join(dir, 'bad.yaml'),
      `name: bad\nmax_revisions: 1\non_exhaustion: block\nsteps:\n` +
      `  - agent: builder\n    on:\n      done: { next: reviewer, when: no_such_predicate }\n`);
    expect(() => loadWorkflows(dir)).toThrow(/unknown predicate: no_such_predicate/);
  });

  it('rejects malformed YAML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-yaml-'));
    writeFileSync(join(dir, 'bad.yaml'), 'not: [valid: yaml');
    expect(() => loadWorkflows(dir)).toThrow();
  });
});
