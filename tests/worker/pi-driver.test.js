// tests/worker/pi-driver.test.js
//
// H3 (docs/architecture/harness-pi.md §4.1): verifies the submit_result
// sentinel-file read path in pi-driver.js — the mechanism that lets the
// submit-result pi extension (infra/pi-extensions/submit-result) hand the
// harness a schema-validated envelope via a tool call instead of relying
// on the model to print trailing JSON. Pure-function tests, no pi binary
// or model required: readSubmitResultEnvelope only touches the filesystem.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readSubmitResultEnvelope } from '../../src/worker/pi-driver.js';

const SENTINEL = '.pi-submit-result.json';

const VALID_ENVELOPE = {
  status: 'done',
  summary: 'Added JSDoc to foo().',
  artifacts: {
    files_created: [],
    files_modified: ['foo.js'],
    commits: ['abc123'],
    branch: 'feat/foo',
    tests_passed: true,
    pr_url: null,
  },
  handoff: { next_agent: null, reason: '' },
  memory_writes_count: 1,
  blockers: [],
  issues_found: [],
};

describe('readSubmitResultEnvelope', () => {
  let cwd;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pi-driver-test-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns ok:false when no sentinel file exists', () => {
    const result = readSubmitResultEnvelope(cwd);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no sentinel file/);
  });

  it('reads and validates a well-formed envelope', () => {
    writeFileSync(join(cwd, SENTINEL), JSON.stringify(VALID_ENVELOPE), 'utf8');
    const result = readSubmitResultEnvelope(cwd);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(VALID_ENVELOPE);
  });

  it('deletes the sentinel file after a successful read (no leak across retries)', () => {
    const path = join(cwd, SENTINEL);
    writeFileSync(path, JSON.stringify(VALID_ENVELOPE), 'utf8');
    readSubmitResultEnvelope(cwd);
    expect(existsSync(path)).toBe(false);
  });

  it('deletes the sentinel file even when validation fails (no stale envelope leaks into a retry)', () => {
    const path = join(cwd, SENTINEL);
    writeFileSync(path, JSON.stringify({ status: 'done' }), 'utf8');
    const result = readSubmitResultEnvelope(cwd);
    expect(result.ok).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it('rejects malformed JSON', () => {
    writeFileSync(join(cwd, SENTINEL), '{not valid json', 'utf8');
    const result = readSubmitResultEnvelope(cwd);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not valid JSON/);
  });

  it('rejects a payload missing a required field', () => {
    const { summary, ...incomplete } = VALID_ENVELOPE;
    writeFileSync(join(cwd, SENTINEL), JSON.stringify(incomplete), 'utf8');
    const result = readSubmitResultEnvelope(cwd);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing field: summary/);
  });

  it('rejects an invalid status value', () => {
    writeFileSync(join(cwd, SENTINEL), JSON.stringify({ ...VALID_ENVELOPE, status: 'maybe' }), 'utf8');
    const result = readSubmitResultEnvelope(cwd);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid status/);
  });

  it('rejects an empty summary', () => {
    writeFileSync(join(cwd, SENTINEL), JSON.stringify({ ...VALID_ENVELOPE, summary: '  ' }), 'utf8');
    const result = readSubmitResultEnvelope(cwd);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/summary must be non-empty/);
  });

  it('rejects non-array blockers', () => {
    writeFileSync(join(cwd, SENTINEL), JSON.stringify({ ...VALID_ENVELOPE, blockers: 'none' }), 'utf8');
    const result = readSubmitResultEnvelope(cwd);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/blockers must be array/);
  });

  it('rejects a top-level array instead of an object', () => {
    writeFileSync(join(cwd, SENTINEL), JSON.stringify([VALID_ENVELOPE]), 'utf8');
    const result = readSubmitResultEnvelope(cwd);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not an object/);
  });

  it('accepts status blocked with non-empty blockers', () => {
    const blocked = {
      ...VALID_ENVELOPE,
      status: 'blocked',
      blockers: ['need access to the staging DB'],
    };
    writeFileSync(join(cwd, SENTINEL), JSON.stringify(blocked), 'utf8');
    const result = readSubmitResultEnvelope(cwd);
    expect(result.ok).toBe(true);
    expect(result.data.status).toBe('blocked');
  });
});
