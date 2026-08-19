// tests/lib/exec-ssh.test.js
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSsh } from '../../src/lib/exec-ssh.js';

describe('execSsh', () => {
  it('resolves (never throws) when the ssh binary does not exist', async () => {
    const r = await execSsh('deploy@host', 'uptime', { sshBin: '/nonexistent/ssh' });
    expect(r.exitCode).toBe(-2);
    expect(r.stderr).toMatch(/ENOENT|spawn/);
  });

  it('resolves with stdout and exitCode 0 on success', async () => {
    // `echo` accepts any argv and exits 0 — stands in for a working ssh.
    const r = await execSsh('deploy@host', 'uptime', { sshBin: 'echo' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('deploy@host');
  });

  it('resolves with exitCode -1 and [timeout] marker when the process hangs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'execssh-'));
    const slow = join(dir, 'slow-ssh');
    writeFileSync(slow, '#!/bin/sh\nsleep 60\n');
    chmodSync(slow, 0o755);
    const r = await execSsh('deploy@host', 'uptime', { sshBin: slow, timeoutMs: 200 });
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain('[timeout]');
  });

  it('refuse explicitement quand DEVPANEL_SSH_TOOLS=off (mount API HTTP)', async () => {
    process.env.DEVPANEL_SSH_TOOLS = 'off';
    try {
      const r = await execSsh('deploy@host', 'uptime');
      expect(r.exitCode).toBe(-3);
      expect(r.stderr).toContain('canal worker');
    } finally { delete process.env.DEVPANEL_SSH_TOOLS; }
  });
});
