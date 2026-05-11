import { describe, it, expect } from 'vitest';
import { makeTextScrubber } from '../../src/server/chat-text-scrubber.js';

// The scrubber strips Qwen3-Coder's Hermes-style `<tool_call>...</tool_call>`
// fragments that sometimes leak into the text channel alongside the proper
// structured `tool_calls` field. The tricky bit is chunk-boundary buffering
// — the tag can be split across N text-delta parts and we must hold tail
// content until the closer arrives (or, on flush, drop it as garbage).

async function run(scrubber, deltas) {
  const writer = scrubber.writable.getWriter();
  const reader = scrubber.readable.getReader();
  const out = [];
  const pump = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
  })();
  for (const d of deltas) {
    await writer.write(d);
  }
  await writer.close();
  await pump;
  return out;
}

describe('makeTextScrubber', () => {
  it('passes through clean text deltas unchanged', async () => {
    const out = await run(makeTextScrubber(), [
      { type: 'text-delta', text: 'hello ' },
      { type: 'text-delta', text: 'world' },
    ]);
    expect(out.map((p) => p.text).join('')).toBe('hello world');
  });

  it('strips a complete <tool_call>...</tool_call> block in one chunk', async () => {
    const out = await run(makeTextScrubber(), [
      {
        type: 'text-delta',
        text: 'before <tool_call>{"name":"x"}</tool_call> after',
      },
    ]);
    expect(out.map((p) => p.text).join('')).toBe('before  after');
  });

  it('strips a dangling `function> </tool_call>` close fragment', async () => {
    const out = await run(makeTextScrubber(), [
      { type: 'text-delta', text: 'voici les logs.\nfunction> </tool_call>' },
    ]);
    expect(out.map((p) => p.text).join('')).toBe('voici les logs.\n');
  });

  it('strips a bare orphan </tool_call> close', async () => {
    const out = await run(makeTextScrubber(), [
      { type: 'text-delta', text: 'voici les logs.</tool_call>' },
    ]);
    expect(out.map((p) => p.text).join('')).toBe('voici les logs.');
  });

  it('buffers across chunk boundaries inside a tag', async () => {
    const out = await run(makeTextScrubber(), [
      { type: 'text-delta', text: 'visible <tool_' },
      { type: 'text-delta', text: 'call>{"foo":' },
      { type: 'text-delta', text: '"bar"}</tool_call> tail' },
    ]);
    // Note: the first chunk's "<tool_" isn't a full opening tag, so it
    // passes through as-is, then we buffer once "<tool_call>" appears
    // intact in chunk 2 (after concat with chunk 1 pending). Resulting
    // visible text is "visible " + (everything-after-close).
    expect(out.map((p) => p.text).join('')).toBe('visible  tail');
  });

  it('drops an unclosed <tool_call>... on flush', async () => {
    const out = await run(makeTextScrubber(), [
      { type: 'text-delta', text: 'start ' },
      { type: 'text-delta', text: '<tool_call>{"never":"closed"' },
    ]);
    expect(out.map((p) => p.text).join('')).toBe('start ');
  });

  it('does not mutate non-text-delta parts', async () => {
    const toolCall = {
      type: 'tool-call',
      toolCallId: 'abc',
      toolName: 'fleet_status',
      args: {},
    };
    const finish = { type: 'finish', finishReason: 'stop' };
    const out = await run(makeTextScrubber(), [
      { type: 'text-delta', text: 'hi' },
      toolCall,
      finish,
    ]);
    expect(out).toContainEqual(toolCall);
    expect(out).toContainEqual(finish);
    expect(out.filter((p) => p.type === 'text-delta').map((p) => p.text).join('')).toBe(
      'hi'
    );
  });

  it('handles consecutive tool_call blocks', async () => {
    const out = await run(makeTextScrubber(), [
      {
        type: 'text-delta',
        text: '<tool_call>{"a":1}</tool_call> middle <tool_call>{"b":2}</tool_call>',
      },
    ]);
    expect(out.map((p) => p.text).join('')).toBe(' middle ');
  });
});
