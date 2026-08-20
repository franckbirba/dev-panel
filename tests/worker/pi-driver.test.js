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
import { readSubmitResultEnvelope, buildPiEnv } from '../../src/worker/pi-driver.js';

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

// H8 (docs/architecture/harness-pi.md §3, ADR-005 H8): pi-driver.js used to
// spawn with `env: {...process.env}`, leaking the agents host's ambient
// NODE_ENV=production into every job — the root cause of the 2026-08-11
// lockfile drift (npm install silently omitted devDependencies). buildPiEnv
// is the pure function that replaced the inline spread; tested directly so
// a future edit can't reintroduce the leak without a test failing.
describe('buildPiEnv', () => {
  it('forces NODE_ENV=development even when the host env says production', () => {
    const env = buildPiEnv({
      baseEnv: { NODE_ENV: 'production', HOME: '/home/deploy' },
      jobId: '123',
      agentRole: 'builder',
    });
    expect(env.NODE_ENV).toBe('development');
  });

  it('forces NODE_ENV=development when unset on the host too', () => {
    const env = buildPiEnv({
      baseEnv: { HOME: '/home/deploy' },
      jobId: '123',
      agentRole: 'builder',
    });
    expect(env.NODE_ENV).toBe('development');
  });

  it('injects a deterministic git identity when none is set', () => {
    const env = buildPiEnv({
      baseEnv: { HOME: '/home/deploy' },
      jobId: '123',
      agentRole: 'builder',
    });
    expect(env.GIT_AUTHOR_NAME).toBe('devpanl-agent-builder');
    expect(env.GIT_AUTHOR_EMAIL).toBe('agent@devpanl.dev');
    expect(env.GIT_COMMITTER_NAME).toBe('devpanl-agent-builder');
    expect(env.GIT_COMMITTER_EMAIL).toBe('agent@devpanl.dev');
  });

  it('respects an explicit operator-set git identity instead of clobbering it', () => {
    const env = buildPiEnv({
      baseEnv: {
        HOME: '/home/deploy',
        GIT_AUTHOR_NAME: 'Franck Birba',
        GIT_AUTHOR_EMAIL: 'franckbirba@gmail.com',
      },
      jobId: '123',
      agentRole: 'builder',
    });
    expect(env.GIT_AUTHOR_NAME).toBe('Franck Birba');
    expect(env.GIT_AUTHOR_EMAIL).toBe('franckbirba@gmail.com');
    // Committer defaults from the (unset) committer vars still fill in from
    // whatever author ended up set — but only when committer itself is unset.
    expect(env.GIT_COMMITTER_NAME).toBe('Franck Birba');
  });

  it('strips npm invocation-pollution vars (npm_config_*, npm_lifecycle_*, NODE_OPTIONS)', () => {
    const env = buildPiEnv({
      baseEnv: {
        HOME: '/home/deploy',
        npm_config_production: 'true',
        npm_lifecycle_event: 'postinstall',
        npm_package_name: 'dev-panel',
        NODE_OPTIONS: '--max-old-space-size=128',
      },
      jobId: '123',
      agentRole: 'builder',
    });
    expect(env.npm_config_production).toBeUndefined();
    expect(env.npm_lifecycle_event).toBeUndefined();
    expect(env.npm_package_name).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('does not strip MCP-relevant secrets — they are load-bearing for mcp-bridge child servers', () => {
    const env = buildPiEnv({
      baseEnv: {
        HOME: '/home/deploy',
        PLANE_API_KEY: 'plane-secret',
        ADMIN_API_KEY: 'admin-secret',
        PG_PASSWORD: 'pg-secret',
        GITHUB_TOKEN: 'gh-secret',
      },
      jobId: '123',
      agentRole: 'builder',
    });
    expect(env.PLANE_API_KEY).toBe('plane-secret');
    expect(env.ADMIN_API_KEY).toBe('admin-secret');
    expect(env.PG_PASSWORD).toBe('pg-secret');
    expect(env.GITHUB_TOKEN).toBe('gh-secret');
  });

  it('sets JOB_ID, AGENT_ROLE, and PI_MCP_CONFIG from arguments', () => {
    const env = buildPiEnv({
      baseEnv: { HOME: '/home/deploy' },
      jobId: 'job-42',
      agentRole: 'reviewer',
      PI_MCP_CONFIG: '/home/deploy/.mcp-worker.json',
    });
    expect(env.JOB_ID).toBe('job-42');
    expect(env.AGENT_ROLE).toBe('reviewer');
    expect(env.PI_MCP_CONFIG).toBe('/home/deploy/.mcp-worker.json');
  });

  it('pins PATH to the known-good binary locations under HOME', () => {
    const env = buildPiEnv({
      baseEnv: { HOME: '/home/deploy', PATH: '/some/untrusted/path' },
      jobId: '123',
      agentRole: 'builder',
    });
    expect(env.PATH).toBe(
      '/home/deploy/.npm-global/bin:/home/deploy/.bun/bin:/home/deploy/.local/bin:/usr/local/bin:/usr/bin:/bin'
    );
  });
});
