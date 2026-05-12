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

  it('accepts pretty-printed multi-line JSON at end of output', () => {
    const pretty = JSON.stringify(VALID, null, 2);
    const out = parseResult(`some preamble text\nmore stuff\n${pretty}`);
    expect(out.ok).toBe(true);
    expect(out.data.status).toBe('done');
  });

  it('handles braces inside strings without tripping the brace counter', () => {
    const withBraces = { ...VALID, summary: 'see {bug} in {code}' };
    const pretty = JSON.stringify(withBraces, null, 2);
    const out = parseResult(`noise\n${pretty}\n`);
    expect(out.ok).toBe(true);
    expect(out.data.summary).toBe('see {bug} in {code}');
  });

  it('synthesizes summary from pr_url + commit when LLM drops the field', () => {
    const noSummary = {
      ...VALID,
      artifacts: {
        ...VALID.artifacts,
        commits: ['abc1234567890'],
        pr_url: 'https://github.com/foo/bar/pull/42'
      }
    };
    delete noSummary.summary;
    const out = parseResult('x\n' + JSON.stringify(noSummary));
    expect(out.ok).toBe(true);
    expect(out.data.summary).toContain('PR https://github.com/foo/bar/pull/42');
    expect(out.data.summary).toContain('abc1234567');
  });

  it('synthesizes summary when summary is present but empty string', () => {
    const empty = { ...VALID, summary: '   ', artifacts: { ...VALID.artifacts, pr_url: 'https://x/pr/1' } };
    const out = parseResult('x\n' + JSON.stringify(empty));
    expect(out.ok).toBe(true);
    expect(out.data.summary).toContain('PR https://x/pr/1');
  });

  it('does not synthesize when no artifact context is available', () => {
    const bare = {
      ...VALID,
      artifacts: { files_created: [], files_modified: [], commits: [], branch: null, tests_passed: false, pr_url: null }
    };
    delete bare.summary;
    const out = parseResult('x\n' + JSON.stringify(bare));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/summary/);
  });

  it('handles commits as objects with sha field', () => {
    const objCommits = {
      ...VALID,
      artifacts: { ...VALID.artifacts, commits: [{ sha: 'def9876543210', message: 'fix' }], pr_url: null }
    };
    delete objCommits.summary;
    const out = parseResult('x\n' + JSON.stringify(objCommits));
    expect(out.ok).toBe(true);
    expect(out.data.summary).toContain('def9876543');
  });
});
