// tests/server/jobs-log.test.js
// Sqlite-path coverage only. Pg-path coverage lives in jobs-log.pg.test.js
// behind the DEVPANEL_PG_ORCHESTRATION flag and requires a pg container.
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase } from '../../src/server/db.js';
import { logStep, listSteps, recordMemoryWrite, countMemoryWrites } from '../../src/server/jobs-log.js';

beforeAll(() => {
  // Force sqlite path for this suite.
  delete process.env.DEVPANEL_PG_ORCHESTRATION;
  const dir = mkdtempSync(join(tmpdir(), 'dp-'));
  initMasterDatabase(dir);
});

describe('jobs-log (sqlite path)', () => {
  it('records a step and lists it', async () => {
    await logStep({ job_id: 'j1', agent: 'builder', step: 'parseResult', status: 'ok', duration_ms: 5 });
    const rows = await listSteps('j1');
    expect(rows).toHaveLength(1);
    expect(rows[0].step).toBe('parseResult');
  });
  it('tracks memory writes per job', async () => {
    await recordMemoryWrite('j2', 'm-1');
    await recordMemoryWrite('j2', 'm-2');
    expect(await countMemoryWrites('j2')).toBe(2);
  });
});
