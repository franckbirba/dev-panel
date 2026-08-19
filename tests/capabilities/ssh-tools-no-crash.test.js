// tests/capabilities/ssh-tools-no-crash.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runRemoteCheck } from '../../src/capabilities/run-remote-check.js';
import { hostStatus } from '../../src/capabilities/host-status.js';
import { tailLogSnapshot } from '../../src/capabilities/tail-log-snapshot.js';

describe('SSH tools survive a missing ssh binary (prod crash 2026-08-18)', () => {
  let origPath;
  beforeEach(() => { origPath = process.env.PATH; process.env.PATH = '/nonexistent'; });
  afterEach(() => { process.env.PATH = origPath; });

  it('run_remote_check resolves an error payload instead of crashing', async () => {
    const r = await runRemoteCheck.handler({ host: 'services', command_id: 'redis-ping' });
    expect(r.exit_code).toBe(-2);
    expect(r.stderr).toMatch(/ENOENT|spawn/);
  });

  it('host_status resolves an error payload instead of crashing', async () => {
    const r = await hostStatus.handler({ host: 'services' });
    // host-status formatte l'erreur — le seul contrat ici : on résout, on ne throw pas.
    expect(r).toBeDefined();
  });

  it('tail_log_snapshot resolves an error payload instead of throwing', async () => {
    const r = await tailLogSnapshot.handler({ host: 'services', unit: 'devpanel-worker.service', lines: 5 });
    expect(r.state).toBe('error');
    expect(r.exit_code).toBe(-2);
    expect(r.lines).toEqual([]);
  });
});
