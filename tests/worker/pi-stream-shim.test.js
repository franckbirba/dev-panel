// tests/worker/pi-stream-shim.test.js
//
// Verifies the pi → claude stream-json translator emits the right events
// for the worker's existing classifier (stream-parser.js#classifyEvent).
import { describe, it, expect } from 'vitest';
import { createPiStreamShim, parsePiLine } from '../../src/worker/pi-stream-shim.js';
import { classifyEvent } from '../../src/worker/stream-parser.js';

describe('createPiStreamShim', () => {
  it('emits a system/init event when session lands', () => {
    const out = [];
    const shim = createPiStreamShim({ onTranslatedEvent: (e) => out.push(e) });
    shim.handle({
      type: 'session',
      version: 3,
      id: 'abc-123',
      timestamp: '2026-05-09T18:00:00.000Z',
      cwd: '/tmp/test'
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: 'abc-123' });
    expect(classifyEvent(out[0])).toEqual({ event_type: 'system', event_subtype: 'init' });
  });

  it('reshapes assistant message_end with text content', () => {
    const out = [];
    const shim = createPiStreamShim({ onTranslatedEvent: (e) => out.push(e) });
    shim.handle({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        usage: { input: 10, output: 5, totalTokens: 15 },
        model: 'foo',
        provider: 'bar',
        stopReason: 'stop'
      }
    });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('assistant');
    expect(out[0].message.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(classifyEvent(out[0])).toEqual({ event_type: 'assistant', event_subtype: null });
  });

  it('reshapes assistant message_end with toolCall to tool_use', () => {
    const out = [];
    const shim = createPiStreamShim({ onTranslatedEvent: (e) => out.push(e) });
    shim.handle({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading file' },
          { type: 'toolCall', id: 'call_abc', name: 'read', arguments: { path: 'foo.js' } }
        ]
      }
    });
    expect(out).toHaveLength(1);
    expect(out[0].message.content).toEqual([
      { type: 'text', text: 'reading file' },
      { type: 'tool_use', id: 'call_abc', name: 'read', input: { path: 'foo.js' } }
    ]);
    // Classifier should bucket this as tool_use because content has a tool_use block.
    expect(classifyEvent(out[0])).toEqual({ event_type: 'tool_use', event_subtype: null });
  });

  it('translates tool_execution_end to user/tool_result', () => {
    const out = [];
    const shim = createPiStreamShim({ onTranslatedEvent: (e) => out.push(e) });
    shim.handle({
      type: 'tool_execution_end',
      toolCallId: 'call_abc',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'function foo() {}\n' }] },
      isError: false
    });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('user');
    expect(out[0].message.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_abc',
      content: 'function foo() {}\n',
      is_error: false
    });
    expect(classifyEvent(out[0])).toEqual({ event_type: 'tool_result', event_subtype: null });
  });

  it('preserves tool_result errors', () => {
    const out = [];
    const shim = createPiStreamShim({ onTranslatedEvent: (e) => out.push(e) });
    shim.handle({
      type: 'tool_execution_end',
      toolCallId: 'call_xyz',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'ENOENT' }] },
      isError: true
    });
    expect(out[0].message.content[0].is_error).toBe(true);
  });

  it('emits result/success on agent_end with last assistant text', () => {
    const out = [];
    const shim = createPiStreamShim({ onTranslatedEvent: (e) => out.push(e) });
    // Prime usage from a message_end first.
    shim.handle({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'final summary' }],
        usage: { input: 100, output: 50, totalTokens: 1500 }
      }
    });
    shim.handle({
      type: 'agent_end',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'final summary' }] }
      ]
    });
    const result = out.find(e => e.type === 'result');
    expect(result).toBeDefined();
    expect(result.subtype).toBe('success');
    expect(result.result).toBe('final summary');
    expect(result.usage).toEqual({ input: 100, output: 50, totalTokens: 1500 });
    expect(classifyEvent(result)).toEqual({ event_type: 'result', event_subtype: 'success' });
  });

  it('drops noisy intermediate events (message_update, turn_*, agent_start, tool_execution_start)', () => {
    const out = [];
    const shim = createPiStreamShim({ onTranslatedEvent: (e) => out.push(e) });
    shim.handle({ type: 'agent_start' });
    shim.handle({ type: 'turn_start' });
    shim.handle({ type: 'message_start', message: { role: 'assistant', content: [] } });
    shim.handle({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'P' } });
    shim.handle({ type: 'tool_execution_start', toolCallId: 'call_a', toolName: 'read' });
    shim.handle({ type: 'turn_end', message: {} });
    expect(out).toHaveLength(0);
  });

  it('skips toolResult-role message_end (avoids double-counting with tool_execution_end)', () => {
    const out = [];
    const shim = createPiStreamShim({ onTranslatedEvent: (e) => out.push(e) });
    shim.handle({
      type: 'message_end',
      message: {
        role: 'toolResult',
        content: [{ type: 'text', text: 'duplicate' }]
      }
    });
    expect(out).toHaveLength(0);
  });

  it('emitError synthesizes a result/error_pi for spawn failures', () => {
    const out = [];
    const shim = createPiStreamShim({ onTranslatedEvent: (e) => out.push(e) });
    shim.emitError('process exited with code 1\nstderr: nope');
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('result');
    expect(out[0].subtype).toBe('error_pi');
    expect(out[0].result).toContain('exited with code 1');
    expect(classifyEvent(out[0])).toEqual({ event_type: 'result', event_subtype: 'error_pi' });
  });

  it('end-to-end: handles a recorded read+edit transcript shape', () => {
    const out = [];
    const shim = createPiStreamShim({ onTranslatedEvent: (e) => out.push(e) });
    // Compressed reproduction of the spike stream from /tmp/pi-spike.
    shim.handle({ type: 'session', version: 3, id: 's1', cwd: '/tmp/x' });
    shim.handle({ type: 'agent_start' });
    shim.handle({ type: 'turn_start' });
    shim.handle({ type: 'message_end', message: {
      role: 'user',
      content: [{ type: 'text', text: 'add a JSDoc' }]
    }});
    // Assistant reads foo.js
    shim.handle({ type: 'message_end', message: {
      role: 'assistant',
      content: [
        { type: 'text', text: "I'll read foo.js" },
        { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'foo.js' } }
      ],
      usage: { input: 100, output: 20, totalTokens: 120 }
    }});
    shim.handle({ type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'read',
      result: { content: [{ type: 'text', text: 'function foo() {}' }] }, isError: false });
    // Assistant edits foo.js
    shim.handle({ type: 'message_end', message: {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'call_2', name: 'edit', arguments: { path: 'foo.js', edits: [] } }
      ],
      usage: { input: 200, output: 80, totalTokens: 400 }
    }});
    shim.handle({ type: 'tool_execution_end', toolCallId: 'call_2', toolName: 'edit',
      result: { content: [{ type: 'text', text: 'OK' }] }, isError: false });
    // Final assistant text
    shim.handle({ type: 'message_end', message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done' }],
      usage: { input: 250, output: 100, totalTokens: 600 }
    }});
    shim.handle({ type: 'agent_end', messages: [] });

    const types = out.map(e => classifyEvent(e).event_type);
    // Expect: system, user (prompt), tool_use, tool_result, tool_use, tool_result, assistant, result
    expect(types).toEqual([
      'system', 'user', 'tool_use', 'tool_result',
      'tool_use', 'tool_result', 'assistant', 'result'
    ]);
    // Final usage carried through to result.
    const result = out[out.length - 1];
    expect(result.usage).toEqual({ input: 250, output: 100, totalTokens: 600 });
  });
});

describe('parsePiLine', () => {
  it('parses valid JSON', () => {
    expect(parsePiLine('{"type":"session","id":"x"}')).toEqual({ type: 'session', id: 'x' });
  });
  it('returns null on empty / whitespace', () => {
    expect(parsePiLine('')).toBeNull();
    expect(parsePiLine('   ')).toBeNull();
  });
  it('returns null on malformed JSON', () => {
    expect(parsePiLine('{not json')).toBeNull();
  });
});
