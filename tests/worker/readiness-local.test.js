// ADR-003 §1 (A1-A3) — agents-host readiness checks, run locally by the
// worker (never via SSH from the API — that's the crashed architecture,
// ADR-003 "Alternatives rejetées"). Pure filesystem + git-shell checks
// against an on-disk clone; git itself is mocked via child_process so this
// stays a fast unit test with no real repo.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let workdir;
const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  workdir = await fs.mkdtemp(join(tmpdir(), 'readiness-local-'));
  vi.resetModules();
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  await fs.rm(workdir, { recursive: true, force: true });
});

function mockGit({ remoteUrl = 'git@github.com:EpitechAfrik/Zeno.git', fetchAgeMs = 0, fetchHeadMissing = false } = {}) {
  vi.doMock('child_process', () => ({
    execSync: vi.fn((cmd) => {
      if (cmd.includes('remote get-url')) return remoteUrl + '\n';
      if (cmd.includes('log -1')) {
        if (fetchHeadMissing) {
          const err = new Error('fatal: no such file');
          err.status = 128;
          throw err;
        }
        const ts = new Date(Date.now() - fetchAgeMs).toISOString();
        return ts + '\n';
      }
      return '';
    })
  }));
}

async function loadModule() {
  return import('../../src/worker/readiness-local.js');
}

describe('checkLocalReadiness — A1 clone exists', () => {
  it('fails A1 when local_path does not exist on disk', async () => {
    mockGit();
    const { checkLocalReadiness } = await loadModule();
    const out = await checkLocalReadiness(join(workdir, 'does-not-exist'));
    expect(out.find(c => c.id === 'A1').status).toBe('fail');
  });

  it('fails A1 when local_path exists but has no .git', async () => {
    mockGit();
    const { checkLocalReadiness } = await loadModule();
    await fs.mkdir(join(workdir, 'not-a-repo'));
    const out = await checkLocalReadiness(join(workdir, 'not-a-repo'));
    expect(out.find(c => c.id === 'A1').status).toBe('fail');
  });

  it('passes A1 when local_path is a real clone (.git present)', async () => {
    mockGit();
    const { checkLocalReadiness } = await loadModule();
    const repo = join(workdir, 'zeno');
    await fs.mkdir(join(repo, '.git'), { recursive: true });
    const out = await checkLocalReadiness(repo);
    expect(out.find(c => c.id === 'A1').status).toBe('pass');
  });
});

describe('checkLocalReadiness — A2 fetch freshness', () => {
  let repo;
  beforeEach(async () => {
    repo = join(workdir, 'zeno');
    await fs.mkdir(join(repo, '.git'), { recursive: true });
  });

  it('passes A2 when last fetch is under 48h old', async () => {
    mockGit({ fetchAgeMs: 3 * 3600 * 1000 });
    const { checkLocalReadiness } = await loadModule();
    const out = await checkLocalReadiness(repo);
    expect(out.find(c => c.id === 'A2').status).toBe('pass');
  });

  it('warns A2 when last fetch is over 48h old (not a hard blocker)', async () => {
    mockGit({ fetchAgeMs: 72 * 3600 * 1000 });
    const { checkLocalReadiness } = await loadModule();
    const out = await checkLocalReadiness(repo);
    expect(out.find(c => c.id === 'A2').status).toBe('warn');
  });

  it('warns A2 when FETCH_HEAD is missing (never fetched)', async () => {
    mockGit({ fetchHeadMissing: true });
    const { checkLocalReadiness } = await loadModule();
    const out = await checkLocalReadiness(repo);
    expect(out.find(c => c.id === 'A2').status).toBe('warn');
  });
});

describe('checkLocalReadiness — A3 no token in remote URL (blocking)', () => {
  let repo;
  beforeEach(async () => {
    repo = join(workdir, 'zeno');
    await fs.mkdir(join(repo, '.git'), { recursive: true });
  });

  it('passes A3 for an SSH remote', async () => {
    mockGit({ remoteUrl: 'git@github.com:EpitechAfrik/Zeno.git' });
    const { checkLocalReadiness } = await loadModule();
    const out = await checkLocalReadiness(repo);
    expect(out.find(c => c.id === 'A3').status).toBe('pass');
  });

  it('passes A3 for a plain HTTPS remote with no embedded credential', async () => {
    mockGit({ remoteUrl: 'https://github.com/EpitechAfrik/Zeno.git' });
    const { checkLocalReadiness } = await loadModule();
    const out = await checkLocalReadiness(repo);
    expect(out.find(c => c.id === 'A3').status).toBe('pass');
  });

  it('fails A3 (blocking) when the remote URL embeds a token (the Zeno leak pattern)', async () => {
    mockGit({ remoteUrl: 'https://ghp_abc123token@github.com/EpitechAfrik/Zeno.git' });
    const { checkLocalReadiness } = await loadModule();
    const out = await checkLocalReadiness(repo);
    expect(out.find(c => c.id === 'A3').status).toBe('fail');
  });

  it('fails A3 when the remote URL embeds any user:pass-style credential', async () => {
    mockGit({ remoteUrl: 'https://user:x-oauth-basic@github.com/EpitechAfrik/Zeno.git' });
    const { checkLocalReadiness } = await loadModule();
    const out = await checkLocalReadiness(repo);
    expect(out.find(c => c.id === 'A3').status).toBe('fail');
  });

  it('warns (not fail) when the remote itself cannot be read', async () => {
    vi.doMock('child_process', () => ({
      execSync: vi.fn((cmd) => {
        if (cmd.includes('remote get-url')) {
          const err = new Error('fatal: No such remote');
          err.status = 128;
          throw err;
        }
        return new Date().toISOString();
      })
    }));
    const { checkLocalReadiness } = await loadModule();
    const out = await checkLocalReadiness(repo);
    expect(out.find(c => c.id === 'A3').status).toBe('warn');
  });
});

describe('checkLocalReadiness — no local_path given', () => {
  it('returns all-warn without touching the filesystem when local_path is empty', async () => {
    mockGit();
    const { checkLocalReadiness } = await loadModule();
    const out = await checkLocalReadiness('');
    expect(out.every(c => c.status === 'warn')).toBe(true);
  });
});
