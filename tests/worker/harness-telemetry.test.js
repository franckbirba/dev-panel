// Gap #2 — harness-telemetry: shape + fire-and-forget guarantees.
//
// The runtime guarantee we care about: recordHarnessEvent() must NEVER
// throw and must NEVER reject. Driver call sites are wrapped in defensive
// try/catch but we still want the telemetry surface itself to be a hard
// non-source of failures (a telemetry crash that aborts an agent run
// would be worse than the silent recoveries it's meant to surface).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted; we need a stable module-scope ref into the mock so
// each test can inspect the most recent appendEvent call.
const appendEventMock = vi.fn();

vi.mock('../../src/server/jobs-events.js', () => ({
  appendEvent: (...args) => appendEventMock(...args),
}));

// Imported after the mock is registered.
const { recordHarnessEvent } = await import('../../src/worker/harness-telemetry.js');

describe('recordHarnessEvent', () => {
  beforeEach(() => {
    appendEventMock.mockReset();
    appendEventMock.mockResolvedValue(null);
  });

  it('calls appendEvent with the expected payload shape', () => {
    recordHarnessEvent({
      jobId: 4242,
      harness: 'pi',
      kind: 'synthesis',
      reason: 'no_json_envelope',
      detail: { tool_use_count: 7, files_modified: 2 },
    });

    expect(appendEventMock).toHaveBeenCalledTimes(1);
    const call = appendEventMock.mock.calls[0][0];

    expect(call.job_id).toBe('4242'); // stringified for the DB
    expect(call.event_type).toBe('system');
    expect(call.event_subtype).toBe('harness_telemetry');
    expect(typeof call.seq).toBe('number');
    expect(call.seq).toBeGreaterThan(1_000_000_000_000); // Date.now() sentinel

    expect(call.payload).toMatchObject({
      harness: 'pi',
      kind: 'synthesis',
      reason: 'no_json_envelope',
      detail: { tool_use_count: 7, files_modified: 2 },
    });
    expect(typeof call.payload.recorded_at).toBe('string');
    // ISO-8601 sanity check.
    expect(call.payload.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('normalizes missing detail to null', () => {
    recordHarnessEvent({
      jobId: 'job-1',
      harness: 'claude',
      kind: 'parser_warning',
      reason: 'malformed_stream_lines',
    });

    expect(appendEventMock).toHaveBeenCalledTimes(1);
    expect(appendEventMock.mock.calls[0][0].payload.detail).toBeNull();
  });

  it('swallows appendEvent rejections (never throws)', async () => {
    appendEventMock.mockRejectedValueOnce(new Error('pg gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => recordHarnessEvent({
      jobId: 'job-2',
      harness: 'goose',
      kind: 'schema_violation',
      reason: 'recipe_response_schema_unsatisfied',
    })).not.toThrow();

    // Wait one microtask tick so the rejection lands on the warn handler.
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('swallows synchronous appendEvent throws (never throws)', () => {
    appendEventMock.mockImplementationOnce(() => { throw new Error('boom'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => recordHarnessEvent({
      jobId: 'job-3',
      harness: 'pi',
      kind: 'fallback',
      reason: 'whatever',
    })).not.toThrow();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops events missing required fields without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => recordHarnessEvent({
      harness: 'pi',
      kind: 'synthesis',
      reason: 'x',
      // jobId missing
    })).not.toThrow();
    expect(() => recordHarnessEvent({
      jobId: 1,
      kind: 'synthesis',
      reason: 'x',
      // harness missing
    })).not.toThrow();

    expect(appendEventMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('accepts string jobId as-is', () => {
    recordHarnessEvent({
      jobId: 'bull-abc-123',
      harness: 'claude',
      kind: 'parser_warning',
      reason: 'malformed_stream_lines',
    });
    expect(appendEventMock.mock.calls[0][0].job_id).toBe('bull-abc-123');
  });
});
