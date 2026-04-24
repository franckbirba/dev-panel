// tests/server/jobs-events.pg.test.js
// Pg-path coverage for jobs-events. Skipped when docker is unavailable.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('jobs-events (pg path)', () => {
  let jobsEvents;

  beforeAll(async () => {
    process.env.DEVPANEL_PG_ORCHESTRATION = '1';
    await startPg();
    jobsEvents = await import('../../src/server/jobs-events.js');
  }, 60000);

  afterAll(async () => {
    await stopPg();
    delete process.env.DEVPANEL_PG_ORCHESTRATION;
  });

  beforeEach(() => truncateOrchestration());

  it('appends and lists in seq order', async () => {
    await jobsEvents.appendEvent({ job_id: 'je1', seq: 0, event_type: 'system', event_subtype: 'init', payload: { foo: 1 } });
    await jobsEvents.appendEvent({ job_id: 'je1', seq: 1, event_type: 'assistant', event_subtype: 'text', payload: { msg: 'hi' } });
    const rows = await jobsEvents.listEvents('je1');
    expect(rows).toHaveLength(2);
    expect(rows[0].seq).toBe(0);
    expect(rows[1].seq).toBe(1);
    expect(JSON.parse(rows[0].payload_json).foo).toBe(1);
  });

  it('ON CONFLICT swallows duplicate (job_id, seq)', async () => {
    const first = await jobsEvents.appendEvent({ job_id: 'je2', seq: 0, event_type: 'system', event_subtype: null, payload: { v: 1 } });
    expect(first).not.toBeNull();
    const dup = await jobsEvents.appendEvent({ job_id: 'je2', seq: 0, event_type: 'system', event_subtype: null, payload: { v: 2 } });
    expect(dup).toBeNull();
    const rows = await jobsEvents.listEvents('je2');
    expect(rows).toHaveLength(1);
    // Confirm the first payload survived, not the dup.
    expect(JSON.parse(rows[0].payload_json).v).toBe(1);
  });

  it('filters by after', async () => {
    await jobsEvents.appendEvent({ job_id: 'je3', seq: 0, event_type: 'a', event_subtype: null, payload: {} });
    await jobsEvents.appendEvent({ job_id: 'je3', seq: 1, event_type: 'b', event_subtype: null, payload: {} });
    await jobsEvents.appendEvent({ job_id: 'je3', seq: 2, event_type: 'c', event_subtype: null, payload: {} });
    const rows = await jobsEvents.listEvents('je3', { after: 0 });
    expect(rows.map(r => r.seq)).toEqual([1, 2]);
  });
});
