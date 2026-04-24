// tests/server/jobs-events.test.js
// Sqlite-path coverage for appendEvent/listEvents + dup-seq swallow.
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase } from '../../src/server/db.js';
import { appendEvent, listEvents } from '../../src/server/jobs-events.js';

beforeAll(() => {
  delete process.env.DEVPANEL_PG_ORCHESTRATION;
  const dir = mkdtempSync(join(tmpdir(), 'dp-'));
  initMasterDatabase(dir);
});

describe('jobs-events (sqlite path)', () => {
  it('appends and lists in seq order', async () => {
    await appendEvent({ job_id: 'je1', seq: 0, event_type: 'system', event_subtype: 'init', payload: { foo: 1 } });
    await appendEvent({ job_id: 'je1', seq: 1, event_type: 'assistant', event_subtype: 'text',   payload: { msg: 'hi' } });
    const rows = await listEvents('je1');
    expect(rows).toHaveLength(2);
    expect(rows[0].seq).toBe(0);
    expect(rows[1].seq).toBe(1);
    expect(JSON.parse(rows[0].payload_json).foo).toBe(1);
  });

  it('swallows duplicate seq', async () => {
    const first = await appendEvent({ job_id: 'je2', seq: 0, event_type: 'system', event_subtype: null, payload: { v: 1 } });
    expect(first).not.toBeNull();
    const dup = await appendEvent({ job_id: 'je2', seq: 0, event_type: 'system', event_subtype: null, payload: { v: 2 } });
    expect(dup).toBeNull();
    const rows = await listEvents('je2');
    expect(rows).toHaveLength(1);
  });

  it('filters by after', async () => {
    await appendEvent({ job_id: 'je3', seq: 0, event_type: 'a', event_subtype: null, payload: {} });
    await appendEvent({ job_id: 'je3', seq: 1, event_type: 'b', event_subtype: null, payload: {} });
    await appendEvent({ job_id: 'je3', seq: 2, event_type: 'c', event_subtype: null, payload: {} });
    const rows = await listEvents('je3', { after: 0 });
    expect(rows.map(r => r.seq)).toEqual([1, 2]);
  });
});
