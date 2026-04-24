// tests/server/jobs-log.test.js
// Integration coverage for jobs-log against a throwaway Postgres container
// (applies migration 003). Skipped when docker is unavailable.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('jobs-log', () => {
  let jobsLog;

  beforeAll(async () => {
    await startPg();
    jobsLog = await import('../../src/server/jobs-log.js');
  }, 60000);

  afterAll(async () => {
    await stopPg();
  });

  beforeEach(() => truncateOrchestration());

  it('records a step and lists it', async () => {
    await jobsLog.logStep({ job_id: 'j1', agent: 'builder', step: 'parseResult', status: 'ok', duration_ms: 5 });
    const rows = await jobsLog.listSteps('j1');
    expect(rows).toHaveLength(1);
    expect(rows[0].step).toBe('parseResult');
    expect(rows[0].duration_ms).toBe(5);
  });

  it('tracks memory writes per job (dedup via ON CONFLICT)', async () => {
    await jobsLog.recordMemoryWrite('j2', 'm-1');
    await jobsLog.recordMemoryWrite('j2', 'm-2');
    await jobsLog.recordMemoryWrite('j2', 'm-1'); // dup — should no-op
    expect(await jobsLog.countMemoryWrites('j2')).toBe(2);
  });
});
