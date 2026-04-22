// tests/worker/stream-parser.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseStreamLine, createStreamProcessor } from '../../src/worker/stream-parser.js';

// Mock the jobs-events module to avoid needing a real database
vi.mock('../../src/server/jobs-events.js', () => ({
  insertJobEvent: vi.fn()
}));

import { insertJobEvent } from '../../src/server/jobs-events.js';

describe('parseStreamLine', () => {
  it('parses valid JSON line', () => {
    const result = parseStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}');
    expect(result).toEqual({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] }
    });
  });

  it('returns null for empty line', () => {
    expect(parseStreamLine('')).toBeNull();
    expect(parseStreamLine('  ')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseStreamLine('not json at all')).toBeNull();
    expect(parseStreamLine('{broken')).toBeNull();
  });

  it('handles whitespace-padded lines', () => {
    const result = parseStreamLine('  {"type":"system"}  ');
    expect(result).toEqual({ type: 'system' });
  });
});

describe('createStreamProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes a single complete line', () => {
    const events = [];
    const proc = createStreamProcessor('job-1', {
      onEvent: (evt, seq) => events.push({ ...evt, seq })
    });

    proc.processChunk('{"type":"system","subtype":"init"}\n');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system');
    expect(events[0].seq).toBe(1);
    expect(insertJobEvent).toHaveBeenCalledWith({
      job_id: 'job-1',
      seq: 1,
      event_type: 'system',
      subtype: 'init',
      payload_json: '{"type":"system","subtype":"init"}'
    });
  });

  it('handles chunks split across multiple data events', () => {
    const events = [];
    const proc = createStreamProcessor('job-2', {
      onEvent: (evt) => events.push(evt)
    });

    // First chunk: partial line
    proc.processChunk('{"type":"assis');
    expect(events).toHaveLength(0);

    // Second chunk: rest of line + newline
    proc.processChunk('tant","message":{}}\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant');
  });

  it('processes multiple lines in one chunk', () => {
    const events = [];
    const proc = createStreamProcessor('job-3', {
      onEvent: (evt) => events.push(evt)
    });

    proc.processChunk(
      '{"type":"system","subtype":"init"}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n' +
      '{"type":"result","subtype":"success","result":"done"}\n'
    );

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('system');
    expect(events[1].type).toBe('assistant');
    expect(events[2].type).toBe('result');
  });

  it('increments seq correctly', () => {
    const seqs = [];
    const proc = createStreamProcessor('job-4', {
      onEvent: (_, seq) => seqs.push(seq)
    });

    proc.processChunk('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n');
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('skips malformed lines gracefully', () => {
    const events = [];
    const lines = [];
    const proc = createStreamProcessor('job-5', {
      onEvent: (evt) => events.push(evt),
      onLine: (line) => lines.push(line)
    });

    proc.processChunk('{"type":"ok"}\nnot-json\n{"type":"also-ok"}\n');

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('ok');
    expect(events[1].type).toBe('also-ok');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('not-json');
  });

  it('extracts final text from result event', () => {
    const proc = createStreamProcessor('job-6');

    proc.processChunk('{"type":"result","subtype":"success","result":"final answer"}\n');

    expect(proc.getFinalText()).toBe('final answer');
    expect(proc.getResult()).toEqual({
      type: 'result',
      subtype: 'success',
      result: 'final answer'
    });
  });

  it('tracks assistant text as fallback for getFinalText', () => {
    const proc = createStreamProcessor('job-7');

    proc.processChunk('{"type":"assistant","message":{"content":[{"type":"text","text":"assistant says this"}]}}\n');

    expect(proc.getFinalText()).toBe('assistant says this');
  });

  it('result event overrides assistant text for getFinalText', () => {
    const proc = createStreamProcessor('job-8');

    proc.processChunk(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"intermediate"}]}}\n' +
      '{"type":"result","subtype":"success","result":"final"}\n'
    );

    expect(proc.getFinalText()).toBe('final');
  });

  it('flush processes remaining buffer', () => {
    const events = [];
    const proc = createStreamProcessor('job-9', {
      onEvent: (evt) => events.push(evt)
    });

    proc.processChunk('{"type":"system"}');
    expect(events).toHaveLength(0);

    proc.flush();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system');
  });

  it('getEventCount returns correct count', () => {
    const proc = createStreamProcessor('job-10');

    proc.processChunk('{"type":"a"}\n{"type":"b"}\n');

    expect(proc.getEventCount()).toBe(2);
  });

  it('handles empty chunks without errors', () => {
    const proc = createStreamProcessor('job-11');
    proc.processChunk('');
    proc.processChunk('\n');
    proc.processChunk('\n\n\n');
    expect(proc.getEventCount()).toBe(0);
  });

  it('callback errors do not break the stream', () => {
    const proc = createStreamProcessor('job-12', {
      onEvent: () => { throw new Error('callback boom'); }
    });

    // Should not throw
    proc.processChunk('{"type":"a"}\n{"type":"b"}\n');
    expect(proc.getEventCount()).toBe(2);
  });
});
