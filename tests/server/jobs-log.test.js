// tests/server/jobs-log.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase } from '../../src/server/db.js';
import { logStep, listSteps, recordMemoryWrite, countMemoryWrites } from '../../src/server/jobs-log.js';

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-'));
  initMasterDatabase(dir);
});

describe('jobs-log', () => {
  it('records a step and lists it', () => {
    logStep({ job_id: 'j1', agent: 'builder', step: 'parseResult', status: 'ok', duration_ms: 5 });
    const rows = listSteps('j1');
    expect(rows).toHaveLength(1);
    expect(rows[0].step).toBe('parseResult');
  });
  it('tracks memory writes per job', () => {
    recordMemoryWrite('j2', 'm-1');
    recordMemoryWrite('j2', 'm-2');
    expect(countMemoryWrites('j2')).toBe(2);
  });
});
