// tests/worker/parse-result.test.js
import { describe, it, expect } from 'vitest';
import { parseResult } from '../../src/worker/prompt-builder.js';

const VALID = {
  status: 'done',
  summary: 'ok',
  artifacts: {
    files_created: [],
    files_modified: ['a.js'],
    commits: ['abc'],
    branch: 'feat/wi_1-x',
    tests_passed: true,
    pr_url: null
  },
  handoff: { next_agent: 'reviewer', reason: 'ready' },
  memory_writes_count: 1,
  blockers: [],
  issues_found: []
};

describe('parseResult', () => {
  it('accepts valid JSON on the last line', () => {
    const out = parseResult(`chatty...\n${JSON.stringify(VALID)}`);
    expect(out.ok).toBe(true);
    expect(out.data.status).toBe('done');
  });

  it('accepts JSON inside a fenced block as fallback', () => {
    const out = parseResult('foo\n```json\n' + JSON.stringify(VALID) + '\n```');
    expect(out.ok).toBe(true);
  });

  it('rejects missing status', () => {
    const bad = { ...VALID }; delete bad.status;
    const out = parseResult('x\n' + JSON.stringify(bad));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/status/);
  });

  it('rejects non-enum status', () => {
    const out = parseResult('x\n' + JSON.stringify({ ...VALID, status: 'kinda' }));
    expect(out.ok).toBe(false);
  });

  it('rejects when no JSON present', () => {
    const out = parseResult('just prose, no json');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no json/i);
  });
});
