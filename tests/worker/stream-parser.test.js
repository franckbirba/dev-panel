import { describe, it, expect, vi } from 'vitest';
import { createStreamParser, getFinalResultText, classifyEvent } from '../../src/worker/stream-parser.js';

describe('createStreamParser', () => {
  it('parses one event per newline', () => {
    const events = [];
    const p = createStreamParser(e => events.push(e));
    p.push('{"type":"system","subtype":"init"}\n');
    p.push('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n');
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(0);
    expect(events[0].event.type).toBe('system');
    expect(events[1].seq).toBe(1);
  });

  it('buffers partial lines across chunks', () => {
    const events = [];
    const p = createStreamParser(e => events.push(e));
    p.push('{"type":"sys');
    p.push('tem","subtype":"init"}\n{"type":"result","result":"done"}');
    expect(events).toHaveLength(1);
    p.push('\n');
    expect(events).toHaveLength(2);
    expect(events[1].event.type).toBe('result');
  });

  it('flush emits a trailing unterminated line', () => {
    const events = [];
    const p = createStreamParser(e => events.push(e));
    p.push('{"type":"result","result":"ok"}');
    expect(events).toHaveLength(0);
    p.flush();
    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe('result');
  });

  it('skips malformed JSON without crashing', () => {
    const events = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = createStreamParser(e => events.push(e));
    p.push('{"type":"system"}\n');
    p.push('not valid json\n');
    p.push('{"type":"result","result":"ok"}\n');
    expect(events).toHaveLength(2);
    expect(events.map(e => e.event.type)).toEqual(['system', 'result']);
    expect(p.stats().malformed).toBe(1);
    warn.mockRestore();
  });

  it('keeps seq monotonic even across malformed lines', () => {
    const events = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = createStreamParser(e => events.push(e));
    p.push('{"type":"a"}\n');
    p.push('garbage\n');
    p.push('{"type":"b"}\n');
    expect(events[0].seq).toBe(0);
    expect(events[1].seq).toBe(2); // 1 was consumed by the malformed line
    warn.mockRestore();
  });

  it('ignores empty lines', () => {
    const events = [];
    const p = createStreamParser(e => events.push(e));
    p.push('\n\n{"type":"system"}\n\n');
    expect(events).toHaveLength(1);
  });
});

describe('getFinalResultText', () => {
  it('returns the result event string', () => {
    const events = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } },
      { type: 'result', subtype: 'success', result: '{"status":"done"}' }
    ];
    expect(getFinalResultText(events)).toBe('{"status":"done"}');
  });

  it('picks the latest result when multiple exist', () => {
    const events = [
      { type: 'result', subtype: 'error', result: 'first' },
      { type: 'result', subtype: 'success', result: 'last' }
    ];
    expect(getFinalResultText(events)).toBe('last');
  });

  it('returns empty string when no result event present', () => {
    const events = [{ type: 'system' }, { type: 'assistant' }];
    expect(getFinalResultText(events)).toBe('');
  });

  it('stringifies an object result', () => {
    const events = [{ type: 'result', result: { summary: 'x' } }];
    expect(getFinalResultText(events)).toBe('{"summary":"x"}');
  });
});

describe('classifyEvent', () => {
  it('classifies system init', () => {
    expect(classifyEvent({ type: 'system', subtype: 'init' })).toEqual({
      event_type: 'system', event_subtype: 'init'
    });
  });

  it('classifies assistant text vs tool_use', () => {
    const text = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
    const tool = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } };
    expect(classifyEvent(text).event_type).toBe('assistant');
    expect(classifyEvent(tool).event_type).toBe('tool_use');
  });

  it('classifies user tool_result vs plain user', () => {
    const result = { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } };
    const plain = { type: 'user', message: { content: [{ type: 'text', text: 'go' }] } };
    expect(classifyEvent(result).event_type).toBe('tool_result');
    expect(classifyEvent(plain).event_type).toBe('user');
  });

  it('falls back to unknown for missing type', () => {
    expect(classifyEvent({}).event_type).toBe('unknown');
    expect(classifyEvent(null).event_type).toBe('unknown');
  });
});
